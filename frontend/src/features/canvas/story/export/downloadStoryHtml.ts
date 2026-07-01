/** 故事标题清洗为安全文件名(保留各语言字母数字下划线连字符)。 */
export function safeFileName(title: string | undefined): string {
  const base = (title ?? '')
    .trim()
    .replace(/[^\p{L}\p{N}_-]+/gu, '_')
    .replace(/^_+|_+$/g, '');
  return `${base || 'interactive-story'}.html`;
}

/** 把 HTML 字符串作为文件下载到本地。 */
export function downloadStoryHtml(html: string, title?: string): void {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = safeFileName(title);
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
