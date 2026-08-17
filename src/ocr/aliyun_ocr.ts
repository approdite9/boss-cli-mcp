/**
 * 阿里云 OCR 统一识别（RecognizeAllText）。
 * 使用 V3 签名方式调用 HTTP API，无需安装 SDK。
 * 
 * 环境变量：
 *   BOSS_ALIYUN_ACCESS_KEY_ID     — 阿里云 AccessKey ID
 *   BOSS_ALIYUN_ACCESS_KEY_SECRET — 阿里云 AccessKey Secret
 *   BOSS_ALIYUN_OCR_ENDPOINT      — 可选，默认 ocr-api.cn-hangzhou.aliyuncs.com
 * 
 * @see https://help.aliyun.com/zh/ocr/developer-reference/api-ocr-api-2021-07-07-recognizealltext
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';

const DEFAULT_ENDPOINT = 'ocr-api.cn-hangzhou.aliyuncs.com';
const API_VERSION = '2021-07-07';
const ACTION = 'RecognizeAllText';

function accessKeyId(): string | undefined {
  return process.env.BOSS_ALIYUN_ACCESS_KEY_ID?.trim() || process.env.ALIYUN_ACCESS_KEY_ID?.trim();
}

function accessKeySecret(): string | undefined {
  return process.env.BOSS_ALIYUN_ACCESS_KEY_SECRET?.trim() || process.env.ALIYUN_ACCESS_KEY_SECRET?.trim();
}

function endpoint(): string {
  return process.env.BOSS_ALIYUN_OCR_ENDPOINT?.trim() || DEFAULT_ENDPOINT;
}

export function isAliyunOcrConfigured(): boolean {
  return !!(accessKeyId() && accessKeySecret());
}

/**
 * HMAC-SHA256
 */
function hmacSha256(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

// 本包是 "type": "module"。此前这里在函数体内用 CommonJS 方式动态取 createHash，
// ESM 下该关键字不存在，运行时报 "require is not defined"，OCR 必然失败。
// 依赖一律走文件顶部的 import。
function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * 阿里云 API 签名 V3 (ACS3-HMAC-SHA256)
 * @see https://help.aliyun.com/document_detail/2750180.html
 */
function signRequest(
  method: string,
  path: string,
  query: Record<string, string>,
  headers: Record<string, string>,
  bodyHash: string,
  secret: string,
): string {
  // 1. 构造规范请求
  const sortedQuery = Object.keys(query)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`)
    .join('&');

  const signedHeaders = Object.keys(headers)
    .map((k) => k.toLowerCase())
    .sort();
  const canonicalHeaders = signedHeaders.map((k) => `${k}:${headers[k.toLowerCase()] ?? headers[k]}`).join('\n') + '\n';
  const signedHeadersStr = signedHeaders.join(';');

  const canonicalRequest = [
    method.toUpperCase(),
    path,
    sortedQuery,
    canonicalHeaders,
    signedHeadersStr,
    bodyHash,
  ].join('\n');

  // 2. 构造待签名字符串
  const hashedCanonicalRequest = sha256Hex(canonicalRequest);
  const stringToSign = `ACS3-HMAC-SHA256\n${hashedCanonicalRequest}`;

  // 3. 计算签名
  const signature = hmacSha256(secret, stringToSign).toString('hex');

  return `ACS3-HMAC-SHA256 Credential=${accessKeyId()},SignedHeaders=${signedHeadersStr},Signature=${signature}`;
}

/**
 * 响应结构按官方文档 + 实测响应校准。
 *
 * 早先版本把文字块声明成 `BlockInfo.Blocks[].Content`，实际是
 * `BlockInfo.BlockDetails[].BlockContent`——字段名对不上，那条兜底分支从来取不到东西，
 * 只是因为 `Data.Content` 一直有值、被优先返回，才没暴露出来。
 *
 * @see https://help.aliyun.com/zh/ocr/developer-reference/api-ocr-api-2021-07-07-recognizealltext
 */
type RecognizeAllTextSubImage = {
  SubImageId?: number;
  /** 分段信息（AdvancedConfig.OutputParagraph=true 时返回） */
  ParagraphInfo?: {
    ParagraphCount?: number;
    ParagraphDetails?: Array<{ ParagraphId?: number; ParagraphContent?: string }>;
  };
  /** 成行信息（AdvancedConfig.OutputRow=true 时返回；当前未开启，保留类型以备将来使用） */
  RowInfo?: {
    RowCount?: number;
    RowDetails?: Array<{ RowId?: number; RowContent?: string }>;
  };
  /** 文字块信息（Advanced / General / MultiLang / Commerce / HandWriting 类型默认返回） */
  BlockInfo?: {
    BlockCount?: number;
    BlockDetails?: Array<{
      BlockId?: number;
      BlockContent?: string;
      BlockConfidence?: number;
    }>;
  };
};

type RecognizeAllTextResponse = {
  RequestId?: string;
  Data?: {
    Content?: string;
    Height?: number;
    Width?: number;
    SubImageCount?: number;
    SubImages?: RecognizeAllTextSubImage[];
  };
  Code?: string;
  Message?: string;
};

/**
 * 部分字段会被 JSON 引号包一层（文档示例里 `Content` 就是 `"\"合同编号...\""`）。
 * 只在确实以 ASCII 双引号首尾包裹时才尝试剥离，失败就原样返回。
 */
function unquote(raw: string): string {
  const s = raw.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(s);
      if (typeof parsed === 'string') {
        return parsed;
      }
    } catch {
      // 不是合法 JSON 字符串，保持原样
    }
  }
  return raw;
}

function collect(
  subImages: RecognizeAllTextSubImage[],
  pick: (sub: RecognizeAllTextSubImage) => Array<string | undefined>,
): string[] {
  const out: string[] = [];
  for (const sub of subImages) {
    for (const item of pick(sub)) {
      if (typeof item !== 'string') continue;
      const text = unquote(item).trim();
      if (text.length > 0) out.push(text);
    }
  }
  return out;
}

/**
 * 按可读性从高到低取文字，返回文本与实际使用的粒度。
 *
 * 为什么不再优先用 `Data.Content`：它是「所有文字汇总」，不含任何换行。
 * 实测一份简历 = 3553 字符 / 1 行，公司、岗位、时间段、描述全糊在一起，
 * 交给 LLM 判断时质量明显下降。同一份简历的分段结果是 62 段。
 *
 * 粒度选择（实测数据）：分段 62 段 > 成行 119 行 > 文字块 148 块（中位 19 字符，最短 1 字符，过碎）。
 */
function extractText(data: NonNullable<RecognizeAllTextResponse['Data']>): {
  text: string;
  granularity: string;
} {
  const subImages = data.SubImages ?? [];

  const paragraphs = collect(subImages, (s) =>
    (s.ParagraphInfo?.ParagraphDetails ?? []).map((p) => p.ParagraphContent),
  );
  if (paragraphs.length > 0) {
    return { text: paragraphs.join('\n'), granularity: `分段 ${paragraphs.length} 段` };
  }

  const rows = collect(subImages, (s) => (s.RowInfo?.RowDetails ?? []).map((r) => r.RowContent));
  if (rows.length > 0) {
    return { text: rows.join('\n'), granularity: `成行 ${rows.length} 行` };
  }

  const blocks = collect(subImages, (s) =>
    (s.BlockInfo?.BlockDetails ?? []).map((b) => b.BlockContent),
  );
  if (blocks.length > 0) {
    return { text: blocks.join('\n'), granularity: `文字块 ${blocks.length} 块` };
  }

  if (typeof data.Content === 'string' && data.Content.trim().length > 0) {
    return { text: unquote(data.Content).trim(), granularity: '汇总文本（无换行）' };
  }

  return { text: '', granularity: '空' };
}

/**
 * 对整张 PNG/JPG 做通用文字识别，返回合并文本。
 */
export async function aliyunOcrImageBuffer(imageBuffer: Buffer): Promise<string> {
  const akId = accessKeyId();
  const akSecret = accessKeySecret();
  if (!akId || !akSecret) {
    throw new Error('缺少阿里云 OCR 凭证：请设置 BOSS_ALIYUN_ACCESS_KEY_ID 与 BOSS_ALIYUN_ACCESS_KEY_SECRET');
  }

  const host = endpoint();
  const path = '/';
  const method = 'POST';
  const now = new Date();
  const dateStr = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const nonce = randomUUID();

  // Query 参数
  //
  // `AdvancedConfig` 是文档里的二级对象参数，**必须序列化成 JSON 字符串**传。实测（同一张简历截图）：
  //   AdvancedConfig={"OutputParagraph":true}        → ParagraphInfo 正常返回
  //   AdvancedConfig.OutputParagraph=true（点号）     → 不生效，无 ParagraphInfo
  //   OutputParagraph=true（放顶层）                  → 不生效，无 ParagraphInfo
  // 早先版本把 OutputCharInfo / OutputTable 放在顶层，属于同一类错误——阿里云不读，等于白传。
  //
  // 只开 OutputParagraph、不开 OutputRow：文档注明每个 Output* 都会增加响应时间，
  // 而分段已是简历最合适的粒度；降级路径用**无需额外参数**的 BlockInfo 承担即可。
  const query: Record<string, string> = {
    Action: ACTION,
    Version: API_VERSION,
    Type: 'Advanced',          // 通用文字识别（高精度）
    AdvancedConfig: JSON.stringify({ OutputParagraph: true }),
  };

  // Body 是图片二进制
  const bodyHash = sha256Hex(imageBuffer);

  // 请求头（参与签名的）
  const headers: Record<string, string> = {
    host: host,
    'x-acs-date': dateStr,
    'x-acs-signature-nonce': nonce,
    'x-acs-content-sha256': bodyHash,
    'content-type': 'application/octet-stream',
    'x-acs-action': ACTION,
    'x-acs-version': API_VERSION,
  };

  // 签名
  const authorization = signRequest(method, path, query, headers, bodyHash, akSecret);

  // 发起请求
  const queryString = Object.keys(query)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`)
    .join('&');

  const url = `https://${host}${path}?${queryString}`;

  const res = await fetch(url, {
    method,
    headers: {
      ...headers,
      Authorization: authorization,
    },
    body: new Uint8Array(imageBuffer),
  });

  const data = (await res.json()) as RecognizeAllTextResponse;

  if (!res.ok || data.Code) {
    throw new Error(
      `阿里云 OCR 失败: ${res.status} ${data.Code ?? ''} ${data.Message ?? JSON.stringify(data)}`,
    );
  }

  if (!data.Data) {
    throw new Error('阿里云 OCR 响应缺少 Data 字段。');
  }

  const { text, granularity } = extractText(data.Data);
  if (text.length === 0) {
    throw new Error('阿里云 OCR 返回为空，未识别到文字。');
  }

  // 粒度降级是静默发生的，但会直接影响 LLM 读简历的质量，所以留一条 stderr 记录便于排查。
  // （MCP 下 console.log/info/warn 已被重定向到 stderr，这里直接用 console.error。）
  console.error(`[boss-cli] 阿里云 OCR 粒度：${granularity}，共 ${text.length} 字符`);

  return text;
}

/**
 * 对 base64 编码的图片做 OCR。
 */
export async function aliyunOcrImageBase64(imageBase64: string): Promise<string> {
  const buf = Buffer.from(imageBase64, 'base64');
  return aliyunOcrImageBuffer(buf);
}
