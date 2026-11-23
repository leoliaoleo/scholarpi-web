/**
 * PDF 魔数校验：按规范在文件头前 1024 字节内扫描 `%PDF-`。
 *
 * 下载回来的一串字节可能是登录页、HTML 错误页或跳转链接，光凭 URL 带
 * `.pdf` 不能当作 PDF。这里只认字节本身，与 URL / 扩展名无关。
 */

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

export function isPdfBytes(bytes: ArrayBuffer | null | undefined): boolean {
  if (!bytes || bytes.byteLength < PDF_MAGIC.length) return false;
  const head = new Uint8Array(bytes, 0, Math.min(1024, bytes.byteLength));
  outer: for (let i = 0; i + PDF_MAGIC.length <= head.length; i++) {
    for (let j = 0; j < PDF_MAGIC.length; j++) {
      if (head[i + j] !== PDF_MAGIC[j]) continue outer;
    }
    return true;
  }
  return false;
}
