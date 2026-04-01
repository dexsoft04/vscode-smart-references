import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import * as net from 'net';
import * as tls from 'tls';
import * as crypto from 'crypto';

export interface TranslationProvider {
  translate(text: string): Promise<string>;
}

// ── Claude (Anthropic) ────────────────────────────────────────────────────────

export class ClaudeTranslationProvider implements TranslationProvider {
  constructor(private readonly apiKey: string) {}

  async translate(text: string): Promise<string> {
    const body = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      system: 'You are a professional translator. Translate the following text to Simplified Chinese. Return ONLY the translated text, without any explanation or extra formatting.',
      messages: [{ role: 'user', content: text }],
    });

    const result = await httpPost('api.anthropic.com', '/v1/messages', {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': '2023-06-01',
    }, body);

    const parsed = JSON.parse(result) as { content?: Array<{ type: string; text: string }> };
    const block = parsed.content?.find(b => b.type === 'text');
    if (!block) throw new Error('Claude API returned no text content');
    return block.text.trim();
  }
}

// ── DeepL ─────────────────────────────────────────────────────────────────────

export class DeepLTranslationProvider implements TranslationProvider {
  constructor(private readonly apiKey: string) {}

  async translate(text: string): Promise<string> {
    const isFree = this.apiKey.endsWith(':fx');
    const host = isFree ? 'api-free.deepl.com' : 'api.deepl.com';
    const body = JSON.stringify({ text: [text], target_lang: 'ZH' });

    const result = await httpPost(host, '/v2/translate', {
      'Content-Type': 'application/json',
      'Authorization': `DeepL-Auth-Key ${this.apiKey}`,
    }, body);

    const parsed = JSON.parse(result) as { translations?: Array<{ text: string }> };
    const translation = parsed.translations?.[0]?.text;
    if (!translation) throw new Error('DeepL API returned no translation');
    return translation.trim();
  }
}

// ── Google Translate ──────────────────────────────────────────────────────────

export class GoogleTranslationProvider implements TranslationProvider {
  constructor(private readonly apiKey: string) {}

  async translate(text: string): Promise<string> {
    const body = JSON.stringify({ q: text, target: 'zh-CN', format: 'text' });
    const path = `/language/translate/v2?key=${encodeURIComponent(this.apiKey)}`;

    const result = await httpPost('translation.googleapis.com', path, {
      'Content-Type': 'application/json',
    }, body);

    const parsed = JSON.parse(result) as {
      data?: { translations?: Array<{ translatedText: string }> };
    };
    const translated = parsed.data?.translations?.[0]?.translatedText;
    if (!translated) throw new Error('Google Translate API returned no translation');
    return translated.trim();
  }
}

// ── Baidu Translate ───────────────────────────────────────────────────────────

export class BaiduTranslationProvider implements TranslationProvider {
  constructor(private readonly appId: string, private readonly secretKey: string) {}

  async translate(text: string): Promise<string> {
    const salt = Date.now().toString();
    const sign = crypto.createHash('md5')
      .update(this.appId + text + salt + this.secretKey)
      .digest('hex');
    const body = new URLSearchParams({
      q: text, from: 'auto', to: 'zh', appid: this.appId, salt, sign,
    }).toString();

    const result = await httpPost('fanyi-api.baidu.com', '/api/trans/vip/translate', {
      'Content-Type': 'application/x-www-form-urlencoded',
    }, body);

    const parsed = JSON.parse(result) as {
      trans_result?: Array<{ dst: string }>;
      error_code?: string;
      error_msg?: string;
    };
    if (parsed.error_code) throw new Error(`Baidu Translate error ${parsed.error_code}: ${parsed.error_msg}`);
    const dst = parsed.trans_result?.map(r => r.dst).join('\n');
    if (!dst) throw new Error('Baidu Translate returned no result');
    return dst.trim();
  }
}

// ── Google Translate (free, no key) ──────────────────────────────────────────
// Uses the same unofficial endpoint as popular VS Code translation extensions.
// No API key required; rate-limited by IP (suitable for occasional use).

export class GoogleFreeTranslationProvider implements TranslationProvider {
  async translate(text: string): Promise<string> {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q=${encodeURIComponent(text)}`;
    const result = await httpGet(url);
    if (result.trimStart().startsWith('<')) {
      throw new Error('Google Translate (free) is unavailable — the service may be blocked in your network. Try switching to "baidu" provider in settings.');
    }
    // Response: [[["translated","original",null,null,1],...],null,"en",...]
    const parsed = JSON.parse(result) as Array<unknown>;
    const segments = parsed[0] as Array<[string, ...unknown[]]>;
    if (!Array.isArray(segments)) throw new Error('Unexpected response from Google Translate');
    return segments.map(s => s[0] ?? '').join('').trim();
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createTranslationProvider(
  config: vscode.WorkspaceConfiguration,
): TranslationProvider {
  const provider = config.get<string>('provider', 'google-free');

  if (provider === 'google-free') {
    return new GoogleFreeTranslationProvider();
  }

  if (provider === 'baidu') {
    const credentials = config.get<string>('baiduCredentials', '');
    const colonIdx = credentials.indexOf(':');
    if (colonIdx === -1 || colonIdx === 0 || colonIdx === credentials.length - 1) {
      throw new Error('Baidu credentials must be in "AppID:SecretKey" format (smartReferences.translation.baiduCredentials)');
    }
    return new BaiduTranslationProvider(credentials.slice(0, colonIdx), credentials.slice(colonIdx + 1));
  }

  if (provider === 'google') {
    const key = config.get<string>('googleApiKey', '');
    if (!key) throw new Error('Google API key not configured (smartReferences.translation.googleApiKey)');
    return new GoogleTranslationProvider(key);
  }

  if (provider === 'claude') {
    const key = config.get<string>('claudeApiKey', '');
    if (!key) throw new Error('Claude API key not configured (smartReferences.translation.claudeApiKey)');
    return new ClaudeTranslationProvider(key);
  }

  // deepl
  const key = config.get<string>('deepLApiKey', '');
  if (!key) throw new Error('DeepL API key not configured (smartReferences.translation.deepLApiKey)');
  return new DeepLTranslationProvider(key);
}

// ── Proxy support ─────────────────────────────────────────────────────────────

function getProxyUrl(): string | undefined {
  const vsProxy = vscode.workspace.getConfiguration('http').get<string>('proxy');
  if (vsProxy) {
    console.log(`[smart-refs:translate] proxy from vscode http.proxy: ${vsProxy}`);
    return vsProxy;
  }
  const envProxy = (
    process.env['HTTPS_PROXY'] ?? process.env['https_proxy'] ??
    process.env['HTTP_PROXY'] ?? process.env['http_proxy'] ??
    process.env['ALL_PROXY'] ?? process.env['all_proxy']
  );
  if (envProxy) {
    console.log(`[smart-refs:translate] proxy from env: ${envProxy}`);
  } else {
    console.log('[smart-refs:translate] no proxy detected');
  }
  return envProxy;
}

// Builds an https.Agent that tunnels through an HTTP CONNECT proxy.
function createTunnelAgent(proxyUrl: string): https.Agent {
  const proxy = new URL(proxyUrl);
  const proxyPort = parseInt(proxy.port) || 8080;
  const agent = new https.Agent();

  type ConnectFn = (options: tls.ConnectionOptions & { host?: string; port?: number }, cb: (err: Error | null, socket?: tls.TLSSocket) => void) => void;
  (agent as unknown as { createConnection: ConnectFn }).createConnection =
    (options, cb) => {
      const sock = net.connect(proxyPort, proxy.hostname);
      sock.on('connect', () => {
        const target = `${options.host ?? ''}:${options.port ?? 443}`;
        sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
        sock.once('data', chunk => {
          if (chunk.toString().includes(' 200 ')) {
            const tlsSock = tls.connect({ ...options, socket: sock }, () => cb(null, tlsSock));
            tlsSock.on('error', (e: Error) => cb(e));
          } else {
            cb(new Error(`Proxy CONNECT failed: ${chunk.toString().slice(0, 80)}`));
          }
        });
      });
      sock.on('error', (e: Error) => cb(e));
    };

  return agent;
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

function readResponse(res: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
      } else {
        resolve(text);
      }
    });
    res.on('error', reject);
  });
}

function httpPost(
  hostname: string,
  path: string,
  headers: Record<string, string>,
  body: string,
): Promise<string> {
  const proxyUrl = getProxyUrl();
  const agent = proxyUrl ? createTunnelAgent(proxyUrl) : undefined;
  console.log(`[smart-refs:translate] POST https://${hostname}${path} via=${proxyUrl ?? 'direct'}`);
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path, method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(body) }, agent },
      res => readResponse(res).then(resolve, reject),
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function httpGet(url: string, redirects = 0): Promise<string> {
  const proxyUrl = getProxyUrl();
  const agent = proxyUrl ? createTunnelAgent(proxyUrl) : undefined;
  console.log(`[smart-refs:translate] GET ${url} via=${proxyUrl ?? 'direct'}`);
  return new Promise((resolve, reject) => {
    https.get(url, { agent }, res => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects >= 3) { reject(new Error('Too many redirects')); return; }
        resolve(httpGet(res.headers.location, redirects + 1));
        return;
      }
      readResponse(res).then(resolve, reject);
    }).on('error', reject);
  });
}
