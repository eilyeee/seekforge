import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
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

  useEffect(() => {
    process.stdout.write(mouseOn ? MOUSE_ENABLE : MOUSE_DISABLE);
    return () => {
      process.stdout.write(MOUSE_DISABLE);
      clearTerminalTitle();
    };
  }, [mouseOn]);

  useEffect(() => {
    const name = projectPath.split("/").filter(Boolean).pop() ?? "seekforge";
    setTerminalTitle(`seekforge — ${name}${running ? " ⚙" : ""}`);
  }, [projectPath, running]);

  useEffect(() => {
    const onContinue = (): void => {
      setRawMode(true);
      if (mouseOn) process.stdout.write(MOUSE_ENABLE);
    };
    process.on("SIGCONT", onContinue);
    return () => {
      process.removeListener("SIGCONT", onContinue);
    };
  }, [setRawMode, mouseOn]);

  const suspend = useCallback(() => {
    setRawMode(false);
    process.stdout.write(MOUSE_DISABLE);
    process.kill(process.pid, "SIGTSTP");
  }, [setRawMode]);

  return { mouseOn, setMouseOn, suspend };
}
