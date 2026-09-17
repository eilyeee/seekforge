export declare const LOOPBACK_NO_PROXY: string;

export declare function envProxyRelaunch(proc: {
  env: Record<string, string | undefined>;
  execArgv: readonly string[];
  argv: readonly string[];
  execPath: string;
  allowedFlags: ReadonlySet<string>;
  hasExecve: boolean;
}): { file: string; args: string[]; env: Record<string, string | undefined> } | null;

export declare function relaunchWithEnvProxy(): void;
