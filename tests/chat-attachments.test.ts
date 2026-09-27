import 'fake-indexeddb/auto';
import { DOMParser as XmlDOMParser } from '@xmldom/xmldom';
import { zipSync, unzipSync, strToU8 } from 'fflate';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { prepareChatAttachment } from '../src/chat-attachments';
import { database, getMedia } from '../src/db';

const png = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=',
  ),
  (char) => char.charCodeAt(0),
);

function attachment(bytes: Uint8Array | string, name: string, type = '') {
  return new File([typeof bytes === 'string' ? bytes : bytes.slice()], name, { type });
}

function docx() {
  const xml = (value: string) => strToU8(value);
  return zipSync({
    '[Content_Types].xml': xml(
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    '_rels/.rels': xml(
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ),
    'word/_rels/document.xml.rels': xml(
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>',
    ),
    'word/document.xml': xml(
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body><w:p><w:r><w:t>Hello document</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Cell B</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:drawing><wp:inline><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip r:embed="rId1"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p></w:body></w:document>',
    ),
    'word/media/image1.png': png,
  });
}

beforeAll(() => {
  class TestDOMParser {
    parseFromString(html: string) {
      const document = new XmlDOMParser().parseFromString(
        `<body>${html}</body>`,
        'application/xml',
      );
      Object.defineProperty(document, 'body', { value: document.documentElement });
      return document;
    }
  }
  globalThis.DOMParser = TestDOMParser as unknown as typeof DOMParser;
});

afterEach(async () => {
  await (await database).clear('media');
});

describe('chat attachments', () => {
  it('saves a photo once as both the original and image input', async () => {
    const prepared = await prepareChatAttachment(attachment(png, 'photo.png'));
    expect(prepared.imageIds).toEqual([prepared.id]);
    expect((await getMedia(prepared.id))?.blob.size).toBe(png.length);
  });

  it('reads UTF-8 BOM and rejects invalid text', async () => {
    const prepared = await prepareChatAttachment(
      attachment(new Uint8Array([239, 187, 191, 65]), 'note.txt'),
    );
    expect(prepared.text).toBe('A');
    await expect(
      prepareChatAttachment(attachment(new Uint8Array([0xff]), 'bad.txt')),
    ).rejects.toThrow('UTF-8');
    await expect(
      prepareChatAttachment(attachment('a'.repeat(100_001), 'long.txt')),
    ).rejects.toThrow('10 萬字');
  });

  it('extracts DOCX text, table and image in document order', async () => {
    const prepared = await prepareChatAttachment(attachment(docx(), 'sample.docx'));
    expect(prepared.text).toContain('Hello document');
    expect(prepared.text).toContain('Cell A | Cell B');
    expect(prepared.text).toContain('[圖片 1]');
    expect(prepared.imageIds).toHaveLength(1);
    expect((await getMedia(prepared.imageIds[0]))?.blob.size).toBe(png.length);
  });

  it('rejects legacy Word, fake image and malformed or oversized DOCX', async () => {
    await expect(prepareChatAttachment(attachment('legacy', 'old.doc'))).rejects.toThrow(
      'DOCX 或 PDF',
    );
    await expect(prepareChatAttachment(attachment('wrong', 'fake.png'))).rejects.toThrow('不符');
    await expect(
      prepareChatAttachment(attachment('PK\x03\x04broken', 'broken.docx')),
    ).rejects.toThrow();
    await expect(
      prepareChatAttachment(attachment('a'.repeat(10 * 1024 * 1024 + 1), 'large.docx')),
    ).rejects.toThrow('10 MB');
    expect(await (await database).count('media')).toBe(0);
  });

  it('rejects DOCX with a chart because its visual content cannot be represented', async () => {
    const entries = unzipSync(docx());
    entries['word/charts/chart1.xml'] = strToU8('<chart/>');
    await expect(prepareChatAttachment(attachment(zipSync(entries), 'chart.docx'))).rejects.toThrow(
      '圖表',
    );
    expect(await (await database).count('media')).toBe(0);
  });
});
