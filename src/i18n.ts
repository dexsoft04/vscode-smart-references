import * as vscode from 'vscode';

export function isChineseLocale(): boolean {
  return vscode.env.language.toLowerCase().startsWith('zh');
}

export function t(zh: string, en: string): string {
  return isChineseLocale() ? zh : en;
}
