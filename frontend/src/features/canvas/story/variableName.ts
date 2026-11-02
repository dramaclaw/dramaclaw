/** 把任意 label 转成合法 ink 标识符的基底(字母数字下划线、字母开头)。中文等无法转换时回退 var。 */
export function slugifyName(label: string): string {
  const ascii = label.replace(/[^a-zA-Z0-9_]/g, '');
  if (ascii.length === 0) return 'var';
  const base = /^[a-zA-Z_]/.test(ascii) ? ascii : `var_${ascii}`;
  return base;
}
