import * as vscode from 'vscode';
import { TextSearchTreeProvider, TextSearchGroupingMode, TextSearchRequest, TextSearchReplaceTarget, rgSourceLabel } from '../providers/TextSearchTreeProvider';
import { SymbolSearchProvider } from '../providers/SymbolSearchProvider';
import { SymbolCategory } from '../core/SymbolRanker';
import { DEFAULT_TEXT_SEARCH_HISTORY_LIMIT, normalizeTextSearchHistoryLimit, pushTextSearchHistory, sanitizeTextSearchHistory } from '../core/TextSearchHistory';
import { t } from '../i18n';
import {
  ReplacementSessionRecord,
  buildUndoReplaceDetail,
  formatLogValue,
  createReplaceSessionId,
  executeReplace,
  executeUndo,
} from './textSearchReplace';

export interface TextSearchCommandsDeps {
  context: vscode.ExtensionContext;
  outputChannel: vscode.OutputChannel;
  textSearchProvider: TextSearchTreeProvider;
  symbolSearch: SymbolSearchProvider;
  textSearchView: vscode.TreeView<any>;
}

type ActiveTextSearchInputState = {
  inputBox: vscode.InputBox;
  historyIndex: number;
  draftValue: string;
};

export interface TextSearchCommandsState {
  textSearchDraftRequest: TextSearchRequest;
}

export function registerTextSearchCommands(deps: TextSearchCommandsDeps): {
  disposables: vscode.Disposable[];
  state: TextSearchCommandsState;
  onConfigChange: (e: vscode.ConfigurationChangeEvent) => void;
} {
  const { context, outputChannel, textSearchProvider, symbolSearch, textSearchView } = deps;
  const TEXT_SEARCH_HISTORY_STORAGE_KEY = 'smartReferences.textSearchHistory';

  const getTextSearchHistoryLimit = (): number => normalizeTextSearchHistoryLimit(
    vscode.workspace.getConfiguration('smartReferences').get<number>('textSearch.historySize', DEFAULT_TEXT_SEARCH_HISTORY_LIMIT),
  );
  let textSearchHistory = sanitizeTextSearchHistory(
    context.workspaceState.get<string[]>(TEXT_SEARCH_HISTORY_STORAGE_KEY, []),
    getTextSearchHistoryLimit(),
  );
  void context.workspaceState.update(TEXT_SEARCH_HISTORY_STORAGE_KEY, textSearchHistory);

  let textSearchDraftRequest: TextSearchRequest = textSearchProvider.getEditableRequest();

  const isTextSearchCancelled = (err: unknown): boolean => {
    const message = String(err);
    return message === 'Error: Text search cancelled' || message === 'Text search cancelled';
  };
  const showTextSearchError = (message: string): void => {
    if (message.includes('ENOENT')) {
      vscode.window.showErrorMessage(t('搜索增强内置的 ripgrep 无法启动。', 'Search Enhancement bundled ripgrep failed to start.'));
    } else {
      vscode.window.showErrorMessage(`${t('搜索增强错误', 'Search Enhancement Error')}: ${message}`);
    }
  };

  const textSearchReplaceHistoryKey = 'smartReferences.textSearch.replaceHistory';
  const maxTextSearchReplaceHistory = 20;
  let textSearchReplaceHistory = context.workspaceState.get<ReplacementSessionRecord[]>(textSearchReplaceHistoryKey, []);

  const updateTextSearchUndoContext = (): void => {
    void vscode.commands.executeCommand(
      'setContext',
      'smartReferences.canUndoTextSearchReplace',
      textSearchReplaceHistory.some(session => !session.undoneAt),
    );
  };

  const persistTextSearchReplaceHistory = async (): Promise<void> => {
    await context.workspaceState.update(textSearchReplaceHistoryKey, textSearchReplaceHistory);
    updateTextSearchUndoContext();
  };

  const appendTextSearchReplaceHistory = async (session: ReplacementSessionRecord): Promise<void> => {
    textSearchReplaceHistory = [session, ...textSearchReplaceHistory.filter(item => item.id !== session.id)].slice(0, maxTextSearchReplaceHistory);
    await persistTextSearchReplaceHistory();
  };

  const markTextSearchReplaceSessionUndone = async (sessionId: string): Promise<void> => {
    textSearchReplaceHistory = textSearchReplaceHistory.map(session => (
      session.id === sessionId ? { ...session, undoneAt: new Date().toISOString() } : session
    ));
    await persistTextSearchReplaceHistory();
  };

  const getLastUndoableTextSearchReplaceSession = (): ReplacementSessionRecord | undefined => (
    textSearchReplaceHistory.find(session => !session.undoneAt && session.appliedCount > 0)
  );

  updateTextSearchUndoContext();

  const focusTextSearchView = async (): Promise<void> => {
    await vscode.commands.executeCommand('textSearchTree.focus');
  };

  const updateTextSearchOptionContexts = (): void => {
    void vscode.commands.executeCommand('setContext', 'smartReferences.textSearchIncludeSet', Boolean(textSearchDraftRequest.include));
    void vscode.commands.executeCommand('setContext', 'smartReferences.textSearchExcludeSet', Boolean(textSearchDraftRequest.exclude));
    void vscode.commands.executeCommand('setContext', 'smartReferences.textSearchMatchCase', textSearchDraftRequest.matchCase);
    void vscode.commands.executeCommand('setContext', 'smartReferences.textSearchWholeWord', textSearchDraftRequest.matchWholeWord);
    void vscode.commands.executeCommand('setContext', 'smartReferences.textSearchRegex', textSearchDraftRequest.useRegExp);
    void vscode.commands.executeCommand('setContext', 'smartReferences.textSearchFuzzy', textSearchDraftRequest.fuzzySearch);
  };

  updateTextSearchOptionContexts();

  const showTextSearchWarning = (): void => {
    const warning = textSearchProvider.getLastWarning();
    if (warning) void vscode.window.showWarningMessage(warning);
  };

  outputChannel.appendLine(`[text-search] ripgrep source=${rgSourceLabel}`);

  let activeSearchCts: vscode.CancellationTokenSource | undefined;
  const runTextSearch = async (request: TextSearchRequest): Promise<boolean> => {
    if (activeSearchCts) {
      outputChannel.appendLine('[text-search] cancelling previous search');
      activeSearchCts.cancel();
      activeSearchCts.dispose();
    }
    const cts = new vscode.CancellationTokenSource();
    activeSearchCts = cts;
    const opts: string[] = [];
    if (request.matchCase) opts.push('case');
    if (request.matchWholeWord) opts.push('word');
    if (request.useRegExp) opts.push('regex');
    if (request.fuzzySearch) opts.push('fuzzy');
    if (request.include) opts.push(`in:${request.include}`);
    if (request.exclude) opts.push(`out:${request.exclude}`);
    outputChannel.appendLine(`[text-search] start query=${JSON.stringify(request.query)}${opts.length ? ` [${opts.join(', ')}]` : ''}`);
    const startTime = Date.now();
    await focusTextSearchView();
    return await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t('搜索增强', 'Search Enhancement'), cancellable: true },
      async (_progress, progressToken) => {
        const onProgressCancel = progressToken.onCancellationRequested(() => cts.cancel());
        try {
          const applied = await textSearchProvider.search(request, cts.token);
          const elapsed = Date.now() - startTime;
          if (applied) {
            outputChannel.appendLine(`[text-search] done ${elapsed}ms matches=${textSearchProvider.getMatchCount()} files=${textSearchProvider.getFileCount()}`);
            textSearchDraftRequest = { ...request };
            updateTextSearchOptionContexts();
            textSearchView.description = textSearchProvider.getTitle();
            showTextSearchWarning();
          } else {
            outputChannel.appendLine(`[text-search] skipped ${elapsed}ms (cancelled or superseded)`);
          }
          return applied;
        } catch (err) {
          const elapsed = Date.now() - startTime;
          if (isTextSearchCancelled(err)) {
            outputChannel.appendLine(`[text-search] cancelled ${elapsed}ms`);
            return false;
          }
          const message = String(err);
          outputChannel.appendLine(`[text-search] error ${elapsed}ms ${message}`);
          showTextSearchError(message);
          return false;
        } finally {
          onProgressCancel.dispose();
          if (activeSearchCts === cts) activeSearchCts = undefined;
          cts.dispose();
        }
      },
    );
  };

  const persistTextSearchHistory = async (): Promise<void> => {
    await context.workspaceState.update(TEXT_SEARCH_HISTORY_STORAGE_KEY, textSearchHistory);
  };

  const refreshTextSearchHistoryFromConfig = async (): Promise<void> => {
    const nextHistory = sanitizeTextSearchHistory(textSearchHistory, getTextSearchHistoryLimit());
    const unchanged = nextHistory.length === textSearchHistory.length
      && nextHistory.every((entry, index) => entry === textSearchHistory[index]);
    if (unchanged) return;
    textSearchHistory = nextHistory;
    await persistTextSearchHistory();
  };

  const appendTextSearchHistory = async (query: string): Promise<void> => {
    const nextHistory = pushTextSearchHistory(textSearchHistory, query, getTextSearchHistoryLimit());
    const unchanged = nextHistory.length === textSearchHistory.length
      && nextHistory.every((entry, index) => entry === textSearchHistory[index]);
    if (unchanged) return;
    textSearchHistory = nextHistory;
    await persistTextSearchHistory();
  };

  let activeTextSearchInputState: ActiveTextSearchInputState | undefined;

  const setActiveTextSearchInputState = (state: ActiveTextSearchInputState | undefined): void => {
    activeTextSearchInputState = state;
    void vscode.commands.executeCommand('setContext', 'smartReferences.textSearchInputActive', Boolean(state));
  };

  const applyTextSearchHistory = (direction: 'previous' | 'next'): void => {
    const state = activeTextSearchInputState;
    if (!state) return;
    const history = textSearchHistory;
    if (history.length === 0) return;
    if (direction === 'previous') {
      if (state.historyIndex === -1) state.draftValue = state.inputBox.value;
      if (state.historyIndex < history.length - 1) state.historyIndex += 1;
    } else {
      if (state.historyIndex === -1) return;
      state.historyIndex -= 1;
    }
    state.inputBox.value = state.historyIndex === -1
      ? state.draftValue
      : history[state.historyIndex];
  };

  const refreshTextSearchResults = async (showWarning = true): Promise<void> => {
    try {
      const applied = await textSearchProvider.refresh();
      if (applied) {
        textSearchDraftRequest = textSearchProvider.getEditableRequest();
        updateTextSearchOptionContexts();
        textSearchView.description = textSearchProvider.getTitle();
        if (showWarning) showTextSearchWarning();
      }
    } catch (err) {
      if (isTextSearchCancelled(err)) return;
      showTextSearchError(String(err));
    }
  };

  const promptReplaceText = async (initialValue: string): Promise<string | undefined> => {
    return await vscode.window.showInputBox({
      prompt: t('替换为', 'Replace with'),
      value: initialValue,
      ignoreFocusOut: true,
    });
  };

  const confirmTextSearchReplace = async (
    replaceText: string,
    detailLabel: string,
    confirmLabel: string,
  ): Promise<boolean> => {
    const answer = await vscode.window.showWarningMessage(
      `${t('确认将', 'Replace')} ${detailLabel} ${t('替换为', 'with')} ${JSON.stringify(replaceText)}?`,
      { modal: true, detail: t('替换会按当前显示顺序执行，遇到第一处失败立即停止。', 'Replacement runs in the current display order and stops at the first failure.') },
      confirmLabel,
    );
    return answer === confirmLabel;
  };

  const getCurrentTextSearchQuery = (): string => (textSearchProvider.getSearchRequest()?.query ?? textSearchDraftRequest.query).trim();
  const getTextSearchGroupingLabel = (mode: TextSearchGroupingMode = textSearchProvider.getGroupingMode()): string => (
    mode === 'none'
      ? t('无分组', 'No Grouping')
      : mode === 'content'
        ? t('代码 / 注释', 'Code / Comments')
        : mode === 'fileKind'
          ? t('代码 / 配置文件', 'Code / Config Files')
          : t('组合分组', 'Combined Grouping')
  );
  const applyTextSearchDraft = async (
    nextDraft: TextSearchRequest,
    successMessage?: string,
    queryOverride?: string,
  ): Promise<boolean> => {
    textSearchDraftRequest = nextDraft;
    updateTextSearchOptionContexts();
    const nextQuery = queryOverride !== undefined ? queryOverride.trim() : getCurrentTextSearchQuery();
    if (nextQuery) {
      return await runTextSearch({ ...nextDraft, query: nextQuery });
    }
    if (successMessage) void vscode.window.showInformationMessage(successMessage);
    return false;
  };

  const setTextSearchInclude = async (queryOverride?: string): Promise<boolean> => {
    await focusTextSearchView();
    const include = await vscode.window.showInputBox({
      prompt: t('包含文件 Glob，留空表示不限制', 'Include file glob. Leave empty for no extra limit.'),
      value: textSearchDraftRequest.include,
      ignoreFocusOut: true,
    });
    if (include === undefined) return false;
    const value = include.trim();
    return await applyTextSearchDraft(
      { ...textSearchDraftRequest, include: value },
      value ? `${t('搜索增强已设置包含文件', 'Search Enhancement include set')}: ${value}` : t('搜索增强已清除包含文件限制。', 'Search Enhancement include filter cleared.'),
      queryOverride,
    );
  };

  const setTextSearchExclude = async (queryOverride?: string): Promise<boolean> => {
    await focusTextSearchView();
    const exclude = await vscode.window.showInputBox({
      prompt: t('排除文件 Glob，留空表示不额外排除', 'Exclude file glob. Leave empty for no extra exclude.'),
      value: textSearchDraftRequest.exclude,
      ignoreFocusOut: true,
    });
    if (exclude === undefined) return false;
    const value = exclude.trim();
    return await applyTextSearchDraft(
      { ...textSearchDraftRequest, exclude: value },
      value ? `${t('搜索增强已设置排除文件', 'Search Enhancement exclude set')}: ${value}` : t('搜索增强已清除额外排除规则。', 'Search Enhancement extra exclude cleared.'),
      queryOverride,
    );
  };

  const toggleTextSearchMatchCase = async (queryOverride?: string): Promise<boolean> => {
    await focusTextSearchView();
    const before = textSearchDraftRequest.matchCase;
    return await applyTextSearchDraft(
      { ...textSearchDraftRequest, matchCase: !textSearchDraftRequest.matchCase },
      before ? t('搜索增强已关闭区分大小写。', 'Search Enhancement match case disabled.') : t('搜索增强已开启区分大小写。', 'Search Enhancement match case enabled.'),
      queryOverride,
    );
  };

  const toggleTextSearchWholeWord = async (queryOverride?: string): Promise<boolean> => {
    await focusTextSearchView();
    if (textSearchDraftRequest.fuzzySearch) {
      void vscode.window.showWarningMessage(t('模糊搜索不支持整词匹配，请先关闭模糊搜索。', 'Fuzzy search does not support whole-word matching. Turn off fuzzy search first.'));
      return false;
    }
    const before = textSearchDraftRequest.matchWholeWord;
    return await applyTextSearchDraft(
      { ...textSearchDraftRequest, matchWholeWord: !textSearchDraftRequest.matchWholeWord },
      before ? t('搜索增强已关闭整词匹配。', 'Search Enhancement whole-word matching disabled.') : t('搜索增强已开启整词匹配。', 'Search Enhancement whole-word matching enabled.'),
      queryOverride,
    );
  };

  const toggleTextSearchRegex = async (queryOverride?: string): Promise<boolean> => {
    await focusTextSearchView();
    const before = textSearchDraftRequest.useRegExp;
    return await applyTextSearchDraft(
      {
        ...textSearchDraftRequest,
        useRegExp: !textSearchDraftRequest.useRegExp,
        fuzzySearch: !textSearchDraftRequest.useRegExp ? false : textSearchDraftRequest.fuzzySearch,
      },
      before ? t('搜索增强已关闭正则搜索。', 'Search Enhancement regex disabled.') : t('搜索增强已开启正则搜索。', 'Search Enhancement regex enabled.'),
      queryOverride,
    );
  };

  const toggleTextSearchFuzzy = async (queryOverride?: string): Promise<boolean> => {
    await focusTextSearchView();
    const before = textSearchDraftRequest.fuzzySearch;
    return await applyTextSearchDraft(
      {
        ...textSearchDraftRequest,
        fuzzySearch: !textSearchDraftRequest.fuzzySearch,
        useRegExp: !textSearchDraftRequest.fuzzySearch ? false : textSearchDraftRequest.useRegExp,
        matchWholeWord: !textSearchDraftRequest.fuzzySearch ? false : textSearchDraftRequest.matchWholeWord,
      },
      before ? t('搜索增强已关闭模糊搜索。', 'Search Enhancement fuzzy search disabled.') : t('搜索增强已开启模糊搜索。', 'Search Enhancement fuzzy search enabled.'),
      queryOverride,
    );
  };

  const setTextSearchGrouping = async (queryOverride?: string): Promise<boolean> => {
    await focusTextSearchView();
    const items: Array<{ label: string; description: string; mode: TextSearchGroupingMode }> = [
      { label: t('无分组', 'No Grouping'), description: t('按文件直接显示', 'Show directly by file'), mode: 'none' },
      { label: t('代码 / 注释', 'Code / Comments'), description: t('区分代码和注释命中', 'Separate code and comment matches'), mode: 'content' },
      { label: t('代码 / 配置文件', 'Code / Config Files'), description: t('区分代码文件和配置文件', 'Separate code files and config files'), mode: 'fileKind' },
      { label: t('组合分组', 'Combined Grouping'), description: t('同时按内容和文件类型分组', 'Group by content and file type together'), mode: 'both' },
    ];
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: t('选择搜索结果分组方式', 'Choose result grouping mode'),
      ignoreFocusOut: true,
    });
    if (!pick) return false;
    textSearchProvider.setGroupingMode(pick.mode);
    const nextQuery = queryOverride !== undefined ? queryOverride.trim() : getCurrentTextSearchQuery();
    if (nextQuery) {
      return await runTextSearch({ ...textSearchDraftRequest, query: nextQuery });
    }
    void vscode.window.showInformationMessage(`${t('搜索增强已切换分组', 'Search Enhancement grouping changed')}: ${getTextSearchGroupingLabel(pick.mode)}`);
    return true;
  };

  const configureTextSearch = async (queryOverride?: string): Promise<boolean> => {
    const items = [
      {
        label: t('包含的文件', 'Files to Include'),
        description: textSearchDraftRequest.include || t('全部文件', 'All files'),
        detail: t('设置要搜索的文件 glob，例如 src/**/*.ts', 'Set the file glob to search, for example src/**/*.ts'),
        action: 'include' as const,
      },
      {
        label: t('排除的文件', 'Files to Exclude'),
        description: textSearchDraftRequest.exclude || t('无额外排除', 'No extra exclude'),
        detail: t('设置要忽略的文件 glob，例如 **/*.spec.ts', 'Set the file glob to ignore, for example **/*.spec.ts'),
        action: 'exclude' as const,
      },
      {
        label: t('区分大小写', 'Match Case'),
        description: textSearchDraftRequest.matchCase ? t('已开启', 'Enabled') : t('已关闭', 'Disabled'),
        detail: t('大小写必须完全一致', 'Letter case must match exactly'),
        action: 'matchCase' as const,
      },
      {
        label: t('整词匹配', 'Whole Word'),
        description: textSearchDraftRequest.matchWholeWord ? t('已开启', 'Enabled') : t('已关闭', 'Disabled'),
        detail: t('只匹配完整单词边界', 'Match only complete word boundaries'),
        action: 'wholeWord' as const,
      },
      {
        label: t('正则搜索', 'Regex'),
        description: textSearchDraftRequest.useRegExp ? t('已开启', 'Enabled') : t('已关闭', 'Disabled'),
        detail: t('使用正则表达式查找', 'Search using regular expressions'),
        action: 'regex' as const,
      },
      {
        label: t('模糊搜索', 'Fuzzy Search'),
        description: textSearchDraftRequest.fuzzySearch ? t('已开启', 'Enabled') : t('已关闭', 'Disabled'),
        detail: t('按子序列模糊匹配，适合不完整关键词', 'Use subsequence fuzzy matching for incomplete keywords'),
        action: 'fuzzy' as const,
      },
      {
        label: t('结果分组', 'Grouping'),
        description: getTextSearchGroupingLabel(),
        detail: t('调整搜索结果的展示结构', 'Adjust how search results are grouped'),
        action: 'grouping' as const,
      },
    ];
    const pick = await vscode.window.showQuickPick(items, {
      title: t('搜索选项', 'Search Options'),
      placeHolder: t('选择要调整的一项搜索设置', 'Choose one search setting to adjust'),
      ignoreFocusOut: true,
    });
    if (!pick) return false;
    if (pick.action === 'include') return await setTextSearchInclude(queryOverride);
    if (pick.action === 'exclude') return await setTextSearchExclude(queryOverride);
    if (pick.action === 'matchCase') return await toggleTextSearchMatchCase(queryOverride);
    if (pick.action === 'wholeWord') return await toggleTextSearchWholeWord(queryOverride);
    if (pick.action === 'regex') return await toggleTextSearchRegex(queryOverride);
    if (pick.action === 'fuzzy') return await toggleTextSearchFuzzy(queryOverride);
    return await setTextSearchGrouping(queryOverride);
  };

  const promptTextSearchQuery = async (initialValue: string): Promise<{ kind: string; query: string } | undefined> => {
    const inputBox = vscode.window.createInputBox();
    inputBox.title = t('搜索增强', 'Search Enhancement');
    inputBox.prompt = t('搜索内容', 'Search');
    inputBox.placeholder = t('输入要搜索的文本；可用上下方向键切换搜索历史', 'Enter text to search. Use Up/Down to browse search history.');
    inputBox.value = initialValue;
    inputBox.ignoreFocusOut = true;

    const createButtons = () => ({
      include: {
        iconPath: new vscode.ThemeIcon(textSearchDraftRequest.include ? 'filter-filled' : 'filter'),
        tooltip: `${t('包含文件', 'Include Files')}: ${textSearchDraftRequest.include || t('未设置', 'Not set')}`,
        location: vscode.QuickInputButtonLocation.Inline,
      },
      exclude: {
        iconPath: new vscode.ThemeIcon('exclude'),
        tooltip: `${t('排除文件', 'Exclude Files')}: ${textSearchDraftRequest.exclude || t('未设置', 'Not set')}`,
        location: vscode.QuickInputButtonLocation.Inline,
      },
      matchCase: {
        iconPath: new vscode.ThemeIcon('case-sensitive'),
        tooltip: t('区分大小写', 'Match Case'),
        location: vscode.QuickInputButtonLocation.Input,
        toggle: { checked: textSearchDraftRequest.matchCase },
      },
      wholeWord: {
        iconPath: new vscode.ThemeIcon('whole-word'),
        tooltip: t('整词匹配', 'Whole Word'),
        location: vscode.QuickInputButtonLocation.Input,
        toggle: { checked: textSearchDraftRequest.matchWholeWord },
      },
      regex: {
        iconPath: new vscode.ThemeIcon('regex'),
        tooltip: t('正则搜索', 'Regex'),
        location: vscode.QuickInputButtonLocation.Input,
        toggle: { checked: textSearchDraftRequest.useRegExp },
      },
      fuzzy: {
        iconPath: new vscode.ThemeIcon('search-fuzzy'),
        tooltip: t('模糊搜索', 'Fuzzy Search'),
        location: vscode.QuickInputButtonLocation.Input,
        toggle: { checked: textSearchDraftRequest.fuzzySearch },
      },
      grouping: {
        iconPath: new vscode.ThemeIcon('list-tree'),
        tooltip: `${t('结果分组', 'Grouping')}: ${getTextSearchGroupingLabel()}`,
        location: vscode.QuickInputButtonLocation.Inline,
      },
    });

    let buttons = createButtons();
    const buttonList = () => [
      buttons.include, buttons.exclude,
      buttons.matchCase, buttons.wholeWord, buttons.regex, buttons.fuzzy,
      buttons.grouping,
    ];
    inputBox.buttons = buttonList();

    const refreshButtons = () => {
      buttons = createButtons();
      inputBox.buttons = buttonList();
    };

    const applyOptionChange = () => {
      refreshButtons();
      const existingQuery = textSearchProvider.getSearchRequest()?.query?.trim();
      if (existingQuery) {
        void runTextSearch({ ...textSearchDraftRequest, query: existingQuery });
      } else {
        updateTextSearchOptionContexts();
      }
    };

    const handleToggle = (button: vscode.QuickInputButton) => {
      const name = button === buttons.matchCase ? 'matchCase'
        : button === buttons.wholeWord ? 'wholeWord'
        : button === buttons.regex ? 'regex'
        : 'fuzzy';
      outputChannel.appendLine(`[text-search] toggle ${name}`);
      if (button === buttons.fuzzy) {
        textSearchDraftRequest = {
          ...textSearchDraftRequest,
          fuzzySearch: !textSearchDraftRequest.fuzzySearch,
          useRegExp: !textSearchDraftRequest.fuzzySearch ? false : textSearchDraftRequest.useRegExp,
          matchWholeWord: !textSearchDraftRequest.fuzzySearch ? false : textSearchDraftRequest.matchWholeWord,
        };
      } else if (button === buttons.regex) {
        textSearchDraftRequest = {
          ...textSearchDraftRequest,
          useRegExp: !textSearchDraftRequest.useRegExp,
          fuzzySearch: !textSearchDraftRequest.useRegExp ? false : textSearchDraftRequest.fuzzySearch,
        };
      } else if (button === buttons.matchCase) {
        textSearchDraftRequest = { ...textSearchDraftRequest, matchCase: !textSearchDraftRequest.matchCase };
      } else if (button === buttons.wholeWord) {
        if (textSearchDraftRequest.fuzzySearch) {
          void vscode.window.showWarningMessage(t('模糊搜索不支持整词匹配，请先关闭模糊搜索。', 'Fuzzy search does not support whole-word matching. Turn off fuzzy search first.'));
          refreshButtons();
          return;
        }
        textSearchDraftRequest = { ...textSearchDraftRequest, matchWholeWord: !textSearchDraftRequest.matchWholeWord };
      }
      applyOptionChange();
    };

    const handleFilterInput = async (button: vscode.QuickInputButton) => {
      const isInclude = button === buttons.include;
      const filterName = isInclude ? 'include' : 'exclude';
      const currentValue = isInclude ? textSearchDraftRequest.include : textSearchDraftRequest.exclude;
      const glob = await vscode.window.showInputBox({
        prompt: isInclude
          ? t('包含文件 Glob，留空表示不限制', 'Include file glob. Leave empty for no extra limit.')
          : t('排除文件 Glob，留空表示不额外排除', 'Exclude file glob. Leave empty for no extra exclude.'),
        value: currentValue,
        ignoreFocusOut: true,
      });
      if (glob !== undefined) {
        const value = glob.trim();
        outputChannel.appendLine(`[text-search] set ${filterName}=${JSON.stringify(value)}`);
        textSearchDraftRequest = isInclude
          ? { ...textSearchDraftRequest, include: value }
          : { ...textSearchDraftRequest, exclude: value };
        applyOptionChange();
      }
      refreshButtons();
    };

    const handleGrouping = async () => {
      const items: Array<{ label: string; description: string; mode: TextSearchGroupingMode }> = [
        { label: t('无分组', 'No Grouping'), description: t('按文件直接显示', 'Show directly by file'), mode: 'none' },
        { label: t('代码 / 注释', 'Code / Comments'), description: t('区分代码和注释命中', 'Separate code and comment matches'), mode: 'content' },
        { label: t('代码 / 配置文件', 'Code / Config Files'), description: t('区分代码文件和配置文件', 'Separate code files and config files'), mode: 'fileKind' },
        { label: t('组合分组', 'Combined Grouping'), description: t('同时按内容和文件类型分组', 'Group by content and file type together'), mode: 'both' },
      ];
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: t('选择搜索结果分组方式', 'Choose result grouping mode'),
        ignoreFocusOut: true,
      });
      if (pick) {
        outputChannel.appendLine(`[text-search] set grouping=${pick.mode}`);
        textSearchProvider.setGroupingMode(pick.mode);
        const existingQuery = textSearchProvider.getSearchRequest()?.query?.trim();
        if (existingQuery) {
          void runTextSearch({ ...textSearchDraftRequest, query: existingQuery });
        }
      }
      refreshButtons();
    };

    return await new Promise(resolve => {
      let settled = false;
      let suppressHide = false;
      const state: ActiveTextSearchInputState = {
        inputBox,
        historyIndex: -1,
        draftValue: initialValue,
      };
      setActiveTextSearchInputState(state);

      const finish = (result: { kind: string; query: string } | undefined) => {
        if (settled) return;
        settled = true;
        disposables.forEach(disposable => disposable.dispose());
        if (activeTextSearchInputState?.inputBox === inputBox) {
          setActiveTextSearchInputState(undefined);
        }
        inputBox.hide();
        inputBox.dispose();
        resolve(result);
      };

      const runSubDialog = async (fn: () => Promise<void>) => {
        suppressHide = true;
        inputBox.hide();
        try { await fn(); } finally { suppressHide = false; }
        if (!settled) inputBox.show();
      };

      const disposables: vscode.Disposable[] = [
        inputBox.onDidChangeValue(value => {
          state.historyIndex = -1;
          state.draftValue = value;
        }),
        inputBox.onDidAccept(() => finish({ kind: 'submit', query: inputBox.value })),
        inputBox.onDidTriggerButton(button => {
          if (button === buttons.matchCase || button === buttons.wholeWord
              || button === buttons.regex || button === buttons.fuzzy) {
            handleToggle(button);
          } else if (button === buttons.include || button === buttons.exclude) {
            void runSubDialog(() => handleFilterInput(button));
          } else if (button === buttons.grouping) {
            void runSubDialog(() => handleGrouping());
          }
        }),
        inputBox.onDidHide(() => { if (!suppressHide) finish(undefined); }),
      ];
      inputBox.show();
    });
  };

  const executeTextSearchReplace = async (
    request: TextSearchRequest,
    targets: TextSearchReplaceTarget[],
    mode: 'single' | 'all',
  ): Promise<void> => {
    if (targets.length === 0) return;
    if (request.fuzzySearch) {
      void vscode.window.showWarningMessage(t('模糊搜索结果不支持替换。', 'Fuzzy search results do not support replacement.'));
      return;
    }
    const result = await executeReplace(
      { outputChannel, appendHistory: appendTextSearchReplaceHistory },
      request, targets, mode,
    );
    if (result.error) {
      await refreshTextSearchResults(false);
      void vscode.window.showErrorMessage(result.error);
    } else {
      textSearchDraftRequest = { ...request };
      updateTextSearchOptionContexts();
      await refreshTextSearchResults(false);
      const completed = result.session?.appliedCount ?? 0;
      const sessionId = result.session?.id ?? '';
      void vscode.window.showInformationMessage(
        mode === 'single'
          ? `${t('已替换 1 处命中', 'Replaced 1 match')} (ID: ${sessionId})`
          : `${t('已顺序替换', 'Sequentially replaced')} ${completed} ${t('处命中', 'matches')} (ID: ${sessionId})`,
      );
    }
  };

  const undoLastTextSearchReplaceCmd = vscode.commands.registerCommand(
    'smartReferences.undoLastTextSearchReplace',
    async () => {
      await focusTextSearchView();
      const session = getLastUndoableTextSearchReplaceSession();
      if (!session) {
        void vscode.window.showInformationMessage(t('当前没有可撤销的搜索增强替换。', 'There is no undoable Search Enhancement replacement right now.'));
        return;
      }
      const answer = await vscode.window.showWarningMessage(
        t(`撤销替换批次 ${session.id}，涉及 ${session.files.length} 个文件 / ${session.appliedCount} 处替换？`, `Undo replacement batch ${session.id} affecting ${session.files.length} files / ${session.appliedCount} matches?`),
        { modal: true, detail: buildUndoReplaceDetail(session) },
        t('撤销上次替换', 'Undo Last Replace'),
      );
      if (answer !== t('撤销上次替换', 'Undo Last Replace')) return;

      const result = await executeUndo(outputChannel, session);
      if (result.error) {
        void vscode.window.showErrorMessage(result.error);
      } else {
        await markTextSearchReplaceSessionUndone(session.id);
        await refreshTextSearchResults(false);
        void vscode.window.showInformationMessage(`${t('已撤销替换批次', 'Reverted replacement batch')} ${session.id}`);
      }
    },
  );

  const searchAllCmd = vscode.commands.registerCommand(
    'smartReferences.searchSymbol',
    () => symbolSearch.show([]),
  );
  const searchFunctionCmd = vscode.commands.registerCommand(
    'smartReferences.searchFunction',
    () => symbolSearch.show([SymbolCategory.Function]),
  );
  const searchTypeCmd = vscode.commands.registerCommand(
    'smartReferences.searchType',
    () => symbolSearch.show([SymbolCategory.Class, SymbolCategory.Interface, SymbolCategory.Enum]),
  );
  const submitTextSearchQuery = async (seedQuery: string): Promise<void> => {
    const result = await promptTextSearchQuery(seedQuery);
    if (!result) return;
    const query = result.query;
    const request = { ...textSearchDraftRequest, query };
    if (!query.trim()) {
      textSearchProvider.clear();
      textSearchDraftRequest = { ...request, query: '' };
      updateTextSearchOptionContexts();
      textSearchView.description = '';
      await focusTextSearchView();
      return;
    }
    const applied = await runTextSearch(request);
    if (applied) {
      await appendTextSearchHistory(query);
    }
  };

  const searchTextCmd = vscode.commands.registerCommand(
    'smartReferences.searchText',
    async () => {
      const editor = vscode.window.activeTextEditor;
      const selectedText = editor && !editor.selection.isEmpty
        ? editor.document.getText(editor.selection).trim()
        : undefined;
      const seedQuery = selectedText || textSearchProvider.getSearchRequest()?.query || textSearchDraftRequest.query;
      await submitTextSearchQuery(seedQuery);
    },
  );
  const searchTextFromSelectionCmd = vscode.commands.registerCommand(
    'smartReferences.searchTextFromSelection',
    async () => {
      await vscode.commands.executeCommand('smartReferences.searchText');
    },
  );
  const editTextSearchCmd = vscode.commands.registerCommand(
    'smartReferences.editTextSearch',
    async () => {
      const seedQuery = textSearchProvider.getSearchRequest()?.query || textSearchDraftRequest.query;
      await submitTextSearchQuery(seedQuery);
    },
  );
  const previousTextSearchHistoryCmd = vscode.commands.registerCommand(
    'smartReferences.previousTextSearchHistory',
    () => {
      applyTextSearchHistory('previous');
    },
  );
  const nextTextSearchHistoryCmd = vscode.commands.registerCommand(
    'smartReferences.nextTextSearchHistory',
    () => {
      applyTextSearchHistory('next');
    },
  );
  const refreshTextSearchCmd = vscode.commands.registerCommand(
    'smartReferences.refreshTextSearch',
    async () => {
      await focusTextSearchView();
      if (!textSearchProvider.getSearchRequest()?.query) return;
      await refreshTextSearchResults();
    },
  );
  const configureTextSearchCmd = vscode.commands.registerCommand(
    'smartReferences.configureTextSearch',
    async () => {
      await configureTextSearch();
    },
  );

  const toggleTextSearchMatchCaseCmd = vscode.commands.registerCommand(
    'smartReferences.toggleTextSearchMatchCase',
    async () => {
      await toggleTextSearchMatchCase();
    },
  );

  const toggleTextSearchWholeWordCmd = vscode.commands.registerCommand(
    'smartReferences.toggleTextSearchWholeWord',
    async () => {
      await toggleTextSearchWholeWord();
    },
  );

  const toggleTextSearchRegexCmd = vscode.commands.registerCommand(
    'smartReferences.toggleTextSearchRegex',
    async () => {
      await toggleTextSearchRegex();
    },
  );

  const setTextSearchIncludeCmd = vscode.commands.registerCommand(
    'smartReferences.setTextSearchInclude',
    async () => {
      await setTextSearchInclude();
    },
  );

  const setTextSearchExcludeCmd = vscode.commands.registerCommand(
    'smartReferences.setTextSearchExclude',
    async () => {
      await setTextSearchExclude();
    },
  );

  const toggleTextSearchFuzzyCmd = vscode.commands.registerCommand(
    'smartReferences.toggleTextSearchFuzzy',
    async () => {
      await toggleTextSearchFuzzy();
    },
  );

  const setTextSearchGroupingCmd = vscode.commands.registerCommand(
    'smartReferences.setTextSearchGrouping',
    async () => {
      await setTextSearchGrouping();
    },
  );
  const replaceAllTextSearchResultsCmd = vscode.commands.registerCommand(
    'smartReferences.replaceAllTextSearchResults',
    async () => {
      const targets = textSearchProvider.getOrderedReplaceTargets();
      if (targets.length === 0) {
        vscode.window.showInformationMessage(t('当前没有可替换的搜索结果。', 'There are no replaceable search results right now.'));
        return;
      }
      const baseRequest = textSearchProvider.getEditableRequest();
      const replaceText = await promptReplaceText(textSearchDraftRequest.replaceText || baseRequest.replaceText);
      if (replaceText === undefined) return;
      const request = { ...baseRequest, replaceText };
      const fileCount = new Set(targets.map(target => target.uri)).size;
      const confirmed = await confirmTextSearchReplace(
        replaceText,
        t(`${targets.length} 处命中（${fileCount} 个文件）`, `${targets.length} matches (${fileCount} files)`),
        t('全部替换', 'Replace All'),
      );
      if (!confirmed) return;
      await executeTextSearchReplace(request, targets, 'all');
    },
  );
  const replaceTextSearchMatchCmd = vscode.commands.registerCommand(
    'smartReferences.replaceTextSearchMatch',
    async (item?: any) => {
      const uri = item?.match?.uri?.toString?.() ?? item?.match?.uri?.toString?.call?.(item.match.uri);
      const range = item?.match?.range;
      if (!uri || !range) {
        vscode.window.showInformationMessage(t('请选择一条搜索命中再执行替换。', 'Select a search match before replacing.'));
        return;
      }
      const key = `${uri}#${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`;
      const targets = textSearchProvider.getOrderedReplaceTargets({ targetKey: key });
      if (targets.length === 0) {
        vscode.window.showInformationMessage(t('当前命中已失效，请先刷新搜索结果。', 'The current match is stale. Refresh the search results first.'));
        return;
      }
      const baseRequest = textSearchProvider.getEditableRequest();
      const replaceText = await promptReplaceText(textSearchDraftRequest.replaceText || baseRequest.replaceText);
      if (replaceText === undefined) return;
      const request = { ...baseRequest, replaceText };
      const confirmed = await confirmTextSearchReplace(
        replaceText,
        `${targets[0]?.relativePath ?? t('当前命中', 'Current Match')}:${targets[0]?.lineNumber ?? ''}`,
        t('替换当前命中', 'Replace Current Match'),
      );
      if (!confirmed) return;
      await executeTextSearchReplace(request, targets, 'single');
    },
  );
  const replaceTextSearchSectionCmd = vscode.commands.registerCommand(
    'smartReferences.replaceTextSearchSection',
    async (item?: any) => {
      const sectionKey = item?.bucket?.key;
      const sectionLabel = item?.bucket?.label ?? t('当前分组', 'Current Group');
      if (!sectionKey) {
        vscode.window.showInformationMessage(t('请选择一个搜索分组再执行替换。', 'Select a search group before replacing.'));
        return;
      }
      const targets = textSearchProvider.getOrderedReplaceTargets({ sectionKey });
      if (targets.length === 0) {
        vscode.window.showInformationMessage(t('当前分组没有可替换的搜索结果。', 'There are no replaceable search results in the current group.'));
        return;
      }
      const baseRequest = textSearchProvider.getEditableRequest();
      const replaceText = await promptReplaceText(textSearchDraftRequest.replaceText || baseRequest.replaceText);
      if (replaceText === undefined) return;
      const request = { ...baseRequest, replaceText };
      const fileCount = new Set(targets.map(target => target.uri)).size;
      const confirmed = await confirmTextSearchReplace(
        replaceText,
        t(`分组"${sectionLabel}"中的 ${targets.length} 处命中（${fileCount} 个文件）`, `${targets.length} matches in group "${sectionLabel}" (${fileCount} files)`),
        t('替换当前分组', 'Replace Current Group'),
      );
      if (!confirmed) return;
      await executeTextSearchReplace(request, targets, 'all');
    },
  );
  const replaceTextSearchFileCmd = vscode.commands.registerCommand(
    'smartReferences.replaceTextSearchFile',
    async (item?: any) => {
      const fileUri = item?.bucket?.uri?.toString?.() ?? item?.bucket?.uri?.toString?.call?.(item.bucket.uri);
      const relativePath = item?.bucket?.relativePath ?? t('当前文件', 'Current File');
      if (!fileUri) {
        vscode.window.showInformationMessage(t('请选择一个搜索文件节点再执行替换。', 'Select a search file before replacing.'));
        return;
      }
      const targets = textSearchProvider.getOrderedReplaceTargets({ fileUri });
      if (targets.length === 0) {
        vscode.window.showInformationMessage(t('当前文件没有可替换的搜索结果。', 'There are no replaceable search results in the current file.'));
        return;
      }
      const baseRequest = textSearchProvider.getEditableRequest();
      const replaceText = await promptReplaceText(textSearchDraftRequest.replaceText || baseRequest.replaceText);
      if (replaceText === undefined) return;
      const request = { ...baseRequest, replaceText };
      const confirmed = await confirmTextSearchReplace(
        replaceText,
        t(`文件"${relativePath}"中的 ${targets.length} 处命中`, `${targets.length} matches in file "${relativePath}"`),
        t('替换当前文件', 'Replace Current File'),
      );
      if (!confirmed) return;
      await executeTextSearchReplace(request, targets, 'all');
    },
  );

  const stateProxy: TextSearchCommandsState = {
    get textSearchDraftRequest() { return textSearchDraftRequest; },
  };

  const onConfigChange = (e: vscode.ConfigurationChangeEvent): void => {
    if (e.affectsConfiguration('smartReferences.textSearch.historySize')) {
      void refreshTextSearchHistoryFromConfig();
    }
    if (!textSearchProvider.getQuery()) {
      textSearchDraftRequest = textSearchProvider.getEditableRequest();
    }
    if (textSearchProvider.getQuery() && (
      e.affectsConfiguration('smartReferences.textSearch')
      || e.affectsConfiguration('search.exclude')
      || e.affectsConfiguration('files.exclude')
      || e.affectsConfiguration('search.useIgnoreFiles')
      || e.affectsConfiguration('search.useGlobalIgnoreFiles')
      || e.affectsConfiguration('search.useParentIgnoreFiles')
      || e.affectsConfiguration('search.followSymlinks')
      || e.affectsConfiguration('search.smartCase')
    )) {
      void refreshTextSearchResults(false);
    }
  };

  return {
    disposables: [
      searchAllCmd,
      searchFunctionCmd,
      searchTypeCmd,
      searchTextCmd,
      searchTextFromSelectionCmd,
      editTextSearchCmd,
      previousTextSearchHistoryCmd,
      nextTextSearchHistoryCmd,
      refreshTextSearchCmd,
      configureTextSearchCmd,
      toggleTextSearchMatchCaseCmd,
      toggleTextSearchWholeWordCmd,
      toggleTextSearchRegexCmd,
      setTextSearchIncludeCmd,
      setTextSearchExcludeCmd,
      toggleTextSearchFuzzyCmd,
      setTextSearchGroupingCmd,
      replaceAllTextSearchResultsCmd,
      undoLastTextSearchReplaceCmd,
      replaceTextSearchMatchCmd,
      replaceTextSearchSectionCmd,
      replaceTextSearchFileCmd,
    ],
    state: stateProxy,
    onConfigChange,
  };
}
