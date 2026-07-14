import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { basename } from "node:path";
import { clearTerminalTitle, MOUSE_DISABLE, MOUSE_ENABLE, setTerminalTitle } from "./terminal.js";

export type TerminalLifecycle = {
  mouseOn: boolean;
  setMouseOn: Dispatch<SetStateAction<boolean>>;
  suspend: () => void;
};

export function useTerminalLifecycle(
  initialMouseOn: boolean,
  projectPath: string,
  running: boolean,
  setRawMode: (enabled: boolean) => void,
): TerminalLifecycle {
  const [mouseOn, setMouseOn] = useState(initialMouseOn);
  const title = `seekforge — ${basename(projectPath) || "seekforge"}${running ? " ⚙" : ""}`;

  useEffect(() => {
    process.stdout.write(mouseOn ? MOUSE_ENABLE : MOUSE_DISABLE);
    return () => {
      process.stdout.write(MOUSE_DISABLE);
    };
  }, [mouseOn]);

  useEffect(() => {
    setTerminalTitle(title);
  }, [title]);

  useEffect(
    () => () => {
      clearTerminalTitle();
    },
    [],
  );

  useEffect(() => {
    const onContinue = (): void => {
      setRawMode(true);
      if (mouseOn) process.stdout.write(MOUSE_ENABLE);
      setTerminalTitle(title);
    };
    process.on("SIGCONT", onContinue);
    return () => {
      process.removeListener("SIGCONT", onContinue);
    };
  }, [setRawMode, mouseOn, title]);

  const suspend = useCallback(() => {
    setRawMode(false);
    process.stdout.write(MOUSE_DISABLE);
    process.kill(process.pid, "SIGTSTP");
  }, [setRawMode]);

  return { mouseOn, setMouseOn, suspend };
}
