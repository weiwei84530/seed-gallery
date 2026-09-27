import { unzipSync } from 'fflate';
import { changed, database, mediaRecord, type StoredMedia } from './db';
import type { ChatAttachment } from './chat-types';
import type { Media } from './types';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_CHARS = 100_000;
const MAX_PDF_PAGES = 20;
const MAX_ZIP_BYTES = 40 * 1024 * 1024;
const MAX_ZIP_ENTRY_BYTES = 16 * 1024 * 1024;
const MAX_RENDER_PIXELS = 4_000_000;

function fail(message: string): never {
  throw new Error(message);
}

function boundedText(value: string) {
  if (value.length > MAX_TEXT_CHARS) fail('附件文字超過 10 萬字，請拆成較小的檔案。');
  return value;
}

function validImage(bytes: Uint8Array, extension: string) {
  const jpeg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png =
    bytes.length > 24 && [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b);
  const webp =
    bytes.length > 16 &&
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
  const expected =
    extension === 'jpg' || extension === 'jpeg' ? jpeg : extension === 'png' ? png : webp;
  if (!expected) fail('圖片內容與副檔名不符，請選擇有效的 JPEG、PNG 或 WebP。');
  if (
    png &&
    (!new DataView(bytes.buffer, bytes.byteOffset).getUint32(16) ||
      !new DataView(bytes.buffer, bytes.byteOffset).getUint32(20))
  )
    fail('圖片尺寸無效。');
  return jpeg ? 'image/jpeg' : png ? 'image/png' : 'image/webp';
}

async function checkImageDecode(blob: Blob) {
  if (typeof createImageBitmap !== 'function') return;
  try {
    const bitmap = await createImageBitmap(blob);
    if (!bitmap.width || !bitmap.height) fail('圖片尺寸無效。');
    bitmap.close();
  } catch {
    fail('圖片無法解碼，請選擇有效的 JPEG、PNG 或 WebP。');
  }
}

function zipEntries(bytes: Uint8Array) {
  if (bytes.length < 22 || String.fromCharCode(...bytes.slice(0, 4)) !== 'PK\x03\x04')
    fail('DOCX 檔案內容無效。');
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 5 && bytes[i + 3] === 6) {
      end = i;
      break;
    }
  }
  if (end < 0) fail('DOCX 壓縮資料損壞。');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  if (count > 500 || offset >= end) fail('DOCX 內容過多或格式不支援。');
  const names: string[] = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50)
      fail('DOCX 壓縮目錄損壞。');
    const compressed = view.getUint32(offset + 20, true);
    const expanded = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    if (
      offset + 46 + nameLength + extraLength + commentLength > end ||
      expanded > MAX_ZIP_ENTRY_BYTES ||
      compressed > MAX_FILE_BYTES ||
      (compressed === 0 && expanded !== 0) ||
      expanded > compressed * 200 + 1024
    )
      fail('DOCX 壓縮內容過大或格式無效。');
    total += expanded;
    if (total > MAX_ZIP_BYTES) fail('DOCX 解壓後內容超過 40 MB。');
    const name = new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.subarray(offset + 46, offset + 46 + nameLength),
    );
    if (names.includes(name)) fail('DOCX 含有重複的壓縮項目。');
    names.push(name);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (!names.includes('word/document.xml') || !names.includes('[Content_Types].xml'))
    fail('這不是有效的 DOCX 文件。');
  if (
    names.some(
      (name) =>
        /^word\/(charts|diagrams|embeddings|drawings|activeX)\//i.test(name) ||
        /\.emf$|\.wmf$|\.svg$/i.test(name),
    )
  )
    fail('DOCX 含有目前無法完整讀取的圖表或特殊圖形，請先另存為 PDF。');
  return names;
}

async function pdfPages(bytes: Uint8Array, name: string, add: (blob: Blob, name: string) => void) {
  if (bytes.length < 8 || new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-')
    fail('PDF 檔案內容無效。');
  const pdfjs = await import('pdfjs-dist');
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const task = pdfjs.getDocument({ data: bytes, useSystemFonts: true });
  let pdf;
  try {
    pdf = await task.promise;
    if (pdf.numPages < 1 || pdf.numPages > MAX_PDF_PAGES)
      fail(`PDF 最多支援 ${MAX_PDF_PAGES} 頁，請拆分檔案後重試。`);
    const text: string[] = [];
    for (let index = 1; index <= pdf.numPages; index++) {
      const page = await pdf.getPage(index);
      const initial = page.getViewport({ scale: 1 });
      const scale = Math.min(2, Math.sqrt(MAX_RENDER_PIXELS / (initial.width * initial.height)));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      const context = canvas.getContext('2d');
      if (!context) fail('瀏覽器無法繪製 PDF 頁面。');
      await page.render({ canvas, canvasContext: context, viewport }).promise;
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      canvas.width = canvas.height = 0;
      if (!blob) fail('PDF 頁面轉成圖片失敗。');
      add(blob, `${name}-page-${index}.png`);
      const content = await page.getTextContent();
      const pageText = content.items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' ')
        .trim();
      text.push(`[第 ${index} 頁，圖片 ${index}]${pageText ? `\n${pageText}` : ''}`);
      boundedText(text.join('\n\n'));
      page.cleanup();
    }
    return text.join('\n\n');
  } finally {
    await task.destroy();
  }
}

function structuredHtml(html: string, imageCount: number) {
  if (typeof DOMParser === 'undefined') fail('瀏覽器無法讀取 DOCX 內容。');
  const document = new DOMParser().parseFromString(html, 'text/html');
  const lines: string[] = [];
  let images = 0;
  function walk(node: Node): string {
    if (node.nodeType === 3) return node.textContent ?? '';
    if (node.nodeType !== 1) return '';
    const element = node as Element;
    const tag = element.tagName.toLowerCase();
    if (tag === 'img') {
      const src = element.getAttribute('src') ?? '';
      if (!/^data:image\/(png|jpeg|webp);base64,/i.test(src))
        fail('DOCX 含有無法讀取的外部圖片或圖片格式，請另存為 PDF。');
      images++;
      return `[圖片 ${images}]`;
    }
    if (tag === 'script' || tag === 'style' || tag === 'iframe')
      fail('DOCX 含有無法安全讀取的內容。');
    if (tag === 'table') {
      const children = (parent: Element) =>
        Array.from(parent.childNodes).filter((child): child is Element => child.nodeType === 1);
      const rows = children(element).flatMap((child) =>
        child.tagName.toLowerCase() === 'tr' ? [child] : children(child),
      );
      return rows
        .map((row) =>
          children(row)
            .map((cell) => walk(cell).trim())
            .join(' | '),
        )
        .join('\n');
    }
    const content = Array.from(element.childNodes).map(walk).join('');
    if (['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'table', 'br'].includes(tag))
      return `${content}\n`;
    return content;
  }
  for (const node of Array.from(document.body.childNodes)) lines.push(walk(node));
  if (images !== imageCount) fail('DOCX 圖片無法完整讀取，請另存為 PDF。');
  return boundedText(
    lines
      .join('')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
  );
}

async function docxContent(bytes: Uint8Array, add: (blob: Blob, name: string) => void) {
  const names = zipEntries(bytes);
  const embedded = names.filter((name) => /^word\/media\/[^/]+$/i.test(name));
  if (embedded.some((name) => !/\.(png|jpe?g|webp)$/i.test(name)))
    fail('DOCX 含有目前無法讀取的內嵌圖片格式，請另存為 PDF。');
  const unzipped = unzipSync(bytes, {
    filter: (entry) =>
      /^word\/media\/[^/]+$/i.test(entry.name) ||
      entry.name === 'word/document.xml' ||
      /^word\/_rels\/[^/]+\.rels$/i.test(entry.name),
  });
  const documentXml = new TextDecoder('utf-8', { fatal: true }).decode(
    unzipped['word/document.xml'],
  );
  const externalImage = Object.entries(unzipped).some(
    ([name, value]) =>
      name.endsWith('.rels') &&
      /<Relationship\b(?=[^>]*TargetMode\s*=\s*["']External["'])(?=[^>]*Type\s*=\s*["'][^"']*\/image["'])/i.test(
        new TextDecoder().decode(value),
      ),
  );
  if (
    /<(?:\w+:)?(?:pict|object|altChunk|chart|graphicFrame)\b/i.test(documentXml) ||
    /<(?:\w+:)?blip\b[^>]*\b(?:\w+:)?link\s*=/i.test(documentXml) ||
    externalImage
  )
    fail('DOCX 含有無法完整讀取的圖形或外部圖片，請另存為 PDF。');
  const mammoth = await import('mammoth');
  const used: string[] = [];
  const source = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const input =
    typeof window === 'undefined' ? { buffer: Buffer.from(bytes) } : { arrayBuffer: source };
  const result = await mammoth.convertToHtml(input, {
    externalFileAccess: false,
    convertImage: mammoth.images.imgElement(async (image) => {
      const base64 = await image.readAsBase64String();
      const mime = image.contentType.toLowerCase();
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime))
        fail('DOCX 含有目前無法讀取的內嵌圖片格式，請另存為 PDF。');
      const binary = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      const matched = embedded.find(
        (name) =>
          unzipped[name] &&
          unzipped[name].length === binary.length &&
          unzipped[name].every((value, index) => value === binary[index]),
      );
      if (!matched) fail('DOCX 內嵌圖片無法完整驗證。');
      used.push(matched);
      validImage(binary, matched.split('.').at(-1)!.toLowerCase());
      const blob = new Blob([binary], { type: mime });
      await checkImageDecode(blob);
      add(blob, matched.split('/').at(-1)!);
      return { src: `data:${mime};base64,${base64}` };
    }),
  });
  if (
    new Set(used).size !== embedded.length ||
    result.messages.some((message) => message.type === 'error')
  )
    fail('DOCX 有無法完整讀取的圖片或內容，請另存為 PDF。');
  return structuredHtml(result.value, used.length);
}

export async function prepareChatAttachment(
  file: File,
  sessionId?: string,
): Promise<ChatAttachment> {
  if (!file || file.size < 1 || file.size > MAX_FILE_BYTES) fail('附件必須大於 0 且不超過 10 MB。');
  const extension = file.name.split('.').at(-1)?.toLowerCase() ?? '';
  if (extension === 'doc') fail('舊版 .doc 無法讀取，請另存為 DOCX 或 PDF 後上傳。');
  if (!['jpg', 'jpeg', 'png', 'webp', 'pdf', 'docx', 'txt'].includes(extension))
    fail('僅支援 JPEG、PNG、WebP、PDF、DOCX 與 TXT。');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length !== file.size) fail('附件讀取不完整，請重試。');
  const id = crypto.randomUUID();
  const pending: Media[] = [{ id, blob: file, name: file.name }];
  const imageIds: string[] = [];
  const add = (blob: Blob, name: string) => {
    const imageId = crypto.randomUUID();
    imageIds.push(imageId);
    pending.push({ id: imageId, blob, name });
  };
  let text: string | undefined;
  let type: string;
  if (['jpg', 'jpeg', 'png', 'webp'].includes(extension)) {
    type = validImage(bytes, extension);
    await checkImageDecode(new Blob([bytes], { type }));
    imageIds.push(id);
  } else if (extension === 'pdf') {
    type = 'application/pdf';
    text = await pdfPages(bytes, file.name, add);
  } else if (extension === 'docx') {
    type = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    text = await docxContent(bytes, add);
  } else {
    type = 'text/plain';
    if (bytes.includes(0)) fail('TXT 含有無法讀取的二進位內容，請儲存為 UTF-8 純文字。');
    try {
      text = boundedText(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''),
      );
    } catch (error) {
      if (error instanceof TypeError) fail('TXT 編碼無效，請儲存為 UTF-8。');
      throw error;
    }
  }
  pending[0].blob = new Blob([await file.arrayBuffer()], { type });
  const records: StoredMedia[] = await Promise.all(pending.map(mediaRecord));
  const attachment = { id, name: file.name, type, size: file.size, text, imageIds };
  const tx = (await database).transaction(['media', 'chats'], 'readwrite');
  void tx.done.catch(() => {});
  try {
    if (sessionId) {
      const session = await tx.objectStore('chats').get(sessionId);
      if (!session) fail('原對話已移除，附件未加入。');
      if (session.draftAttachments.length >= 4) fail('每次最多加入 4 個附件。');
      session.draftAttachments.push(attachment);
      await tx.objectStore('chats').put(session);
    }
    for (const record of records) await tx.objectStore('media').add(record);
    await tx.done;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      /* The transaction may already have aborted. */
    }
    throw error;
  }
  changed();
  return attachment;
}
