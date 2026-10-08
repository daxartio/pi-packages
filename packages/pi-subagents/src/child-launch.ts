import { basename } from "node:path";

export interface PiLauncher {
  executable: string;
  prefixArgs: string[];
}

export function resolvePiLauncher(
  input: {
    executable?: string;
    prefixArgs?: string[];
    override?: string;
    parentExecutable?: string;
    parentScript?: string;
  } = {},
): PiLauncher {
  const prefixArgs = input.prefixArgs ?? [];
  const parentExecutable = input.parentExecutable ?? process.execPath;
  const explicit =
    input.executable ?? input.override ?? process.env.PI_SUBAGENTS_PI;
  if (explicit) {
    return /\.[cm]?js$/u.test(explicit)
      ? { executable: parentExecutable, prefixArgs: [explicit, ...prefixArgs] }
      : { executable: explicit, prefixArgs };
  }
  const script = input.parentScript ?? process.argv[1];
  if (
    script &&
    /(?:^|[/\\])(?:@earendil-works[/\\])?pi-coding-agent[/\\]/u.test(script) &&
    /\.(?:[cm]?js|ts)$/u.test(script)
  ) {
    return {
      executable: parentExecutable,
      prefixArgs: [script, ...prefixArgs],
    };
  }
  if (/^pi(?:\.exe)?$/u.test(basename(parentExecutable))) {
    return { executable: parentExecutable, prefixArgs };
  }
  return { executable: "pi", prefixArgs };
}
