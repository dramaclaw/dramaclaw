import { Compiler } from 'inkjs/full';

/** ink 源码编译失败。`errors` 为 inklecate 带行号的原始报错。 */
export class InkCompileError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(errors[0] ?? 'ink compile failed');
    this.name = 'InkCompileError';
    this.errors = errors;
  }
}

export interface CompiledInkSource {
  /** 编译产物,与 Inky 导出的 story JSON 同格式。 */
  json: string;
  /** 编译期告警与 TODO,原样带行号。 */
  warnings: string[];
}

/**
 * 用 inkjs 把 ink 源码编译成 story JSON,使源码导入与 Inky JSON 导入走同一条解析路径,
 * 并顺带拿到 inklecate 的语法校验。失败抛 {@link InkCompileError}。
 */
export function compileInkSource(source: string): CompiledInkSource {
  const compiler = new Compiler(source);
  let json: string | void = undefined;
  try {
    json = compiler.Compile().ToJson();
  } catch (err) {
    // Compile() 只抛一个笼统的 "Compilation failed",具体报错在 compiler.errors 上。
    throw new InkCompileError(compiler.errors.length ? [...compiler.errors] : [String(err)]);
  }
  if (compiler.errors.length) throw new InkCompileError([...compiler.errors]);
  if (!json) throw new InkCompileError(['ink compile produced no output']);
  return { json, warnings: [...compiler.warnings, ...compiler.authorMessages] };
}
