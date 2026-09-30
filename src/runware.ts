import type { Balance } from './types';

export interface ApiItem {
  taskType?: string;
  taskUUID?: string;
  status?: string;
  imageUUID?: string;
  imageDataURI?: string;
  imageBase64Data?: string;
  imageURL?: string;
  videoURL?: string;
  cost?: number;
  text?: string;
  finishReason?: string;
  code?: string;
  message?: string;
  error?: { code?: string; message?: string };
  balance?: Balance | number;
  connectionSessionUUID?: string;
}
export interface ApiResponse {
  data?: ApiItem[];
  errors?: ApiItem[];
}
export class ApiError extends Error {
  constructor(public code: string) {
    super(friendlyError(code));
  }
}
export const isCredentialError = (code: string) => /key|auth|unauthorized|^401$/i.test(code);
export function friendlyError(code = '') {
  if (isCredentialError(code)) return 'API Key 無效或已停用，請到設定更新。';
  if (/balance|credit|fund/i.test(code)) return '服務帳戶目前無法生成，請至 Runware 檢查帳戶狀態。';
  if (/safety|moderation|nsfw|content/i.test(code))
    return '服務商無法處理這個內容，請調整描述或照片後再試。';
  if (/rate|limit|429/i.test(code)) return '目前請求較多，請稍後再試。';
  if (/permission|forbidden|403/i.test(code)) return '這組 Key 沒有執行此操作的權限。';
  if (/invalid|parameter|model|400/i.test(code))
    return '服務商未接受這次設定，請調整模型或參數後再試。';
  return '暫時無法取得結果，請稍後查詢或至 Runware 查看任務。';
}
export async function request(key: string, task: object): Promise<ApiResponse> {
  const response = await fetch('https://api.runware.ai/v1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify([task]),
    signal: AbortSignal.timeout(45000),
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  });
  let result: ApiResponse;
  try {
    result = await response.json();
  } catch {
    throw new Error('服務回應中斷，請稍後查詢。');
  }
  // A 5xx response cannot prove that a paid request was rejected before execution.
  if (!response.ok && response.status >= 500) throw new Error('服務暫時無法回應，請稍後查詢。');
  if (!response.ok) throw new ApiError(result.errors?.[0]?.code ?? String(response.status));
  if (!Array.isArray(result.data) && !Array.isArray(result.errors))
    throw new Error('無法辨識服務回應，請稍後查詢。');
  return result;
}
export async function validateKey(key: string) {
  const result = await request(key, { taskType: 'authentication', apiKey: key });
  if (result.errors?.length) throw new ApiError(result.errors[0].code ?? 'authentication');
  // REST authentication acknowledges valid credentials with an empty data array.
  // connectionSessionUUID belongs to WebSocket sessions and is not required here.
  if (!Array.isArray(result.data)) throw new Error('服務尚未確認 Key 有效，請稍後再試。');
}
export async function fetchBalance(key: string): Promise<Balance> {
  const result = await request(key, {
    taskType: 'accountManagement',
    taskUUID: crypto.randomUUID(),
    operation: 'getDetails',
  });
  if (result.errors?.length) throw new ApiError(result.errors[0].code ?? 'permission');
  const rawBalance = result.data?.find((i) => i.balance !== undefined)?.balance;
  // The live REST API also returns the USD balance as a scalar number.
  const balance =
    typeof rawBalance === 'number' ? { amount: rawBalance, currency: 'USD' } : rawBalance;
  if (!balance || !Number.isFinite(balance.amount) || balance.currency !== 'USD')
    throw new Error('目前無法讀取餘額。');
  return {
    amount: balance.amount,
    currency: balance.currency,
    ...(Number.isFinite(balance.freeBalance) ? { freeBalance: balance.freeBalance } : {}),
  };
}
export async function keyTag(key: string) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)),
  );
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
export function blobDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('無法讀取照片。'));
    reader.readAsDataURL(blob);
  });
}
export async function resultBlob(item: ApiItem) {
  const source =
    item.imageDataURI ??
    (item.imageBase64Data ? `data:image/png;base64,${item.imageBase64Data}` : item.imageURL);
  if (!source) throw new Error('尚未收到圖片資料。');
  const inline = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/i.exec(source);
  if (inline) {
    if (inline[2].length > 70 * 1024 * 1024) throw new Error('圖片資料過大，無法保存。');
    const decoded = atob(inline[2]);
    const bytes = Uint8Array.from(decoded, (char) => char.charCodeAt(0));
    if (!bytes.length || bytes.length > 50 * 1024 * 1024) throw new Error('圖片資料過大或不完整。');
    return new Blob([bytes], { type: inline[1].toLowerCase() });
  }
  const url = new URL(source);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.runware.ai'))
    throw new Error('圖片來源無法驗證。');
  const response = await fetch(source, {
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    signal: AbortSignal.timeout(45000),
  });
  if (!response.ok) throw new Error('圖片下載未完成，請重新查詢原任務。');
  const blob = await response.blob();
  if (
    !/^image\/(png|jpeg|webp)$/.test(blob.type) ||
    blob.size === 0 ||
    blob.size > 50 * 1024 * 1024
  )
    throw new Error('圖片格式或大小無法保存。');
  return blob;
}

export async function videoBlob(item: ApiItem): Promise<Blob> {
  if (!item.videoURL) throw new Error('尚未收到影片資料。');
  const url = new URL(item.videoURL);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.runware.ai'))
    throw new Error('影片來源無法確認。');
  const response = await fetch(url, {
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    redirect: 'error',
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok || !response.body) throw new Error('影片下載未完成，請查詢原任務重試保存。');
  const limit = 100 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body.cancel();
    throw new Error('影片超過本機單檔 100 MB 限制。');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new Error('影片超過本機單檔 100 MB 限制。');
      }
      chunks.push(new Uint8Array(value));
    }
  } finally {
    reader.releaseLock();
  }
  const blob = new Blob(chunks, { type: 'video/mp4' });
  const signature = new TextDecoder().decode(await blob.slice(4, 8).arrayBuffer());
  if (!size || signature !== 'ftyp') throw new Error('影片格式無法確認，請查詢原任務重試保存。');
  return blob;
}
