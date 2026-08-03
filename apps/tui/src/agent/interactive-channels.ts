import type { ConfirmResult, PermissionRequest } from "@seekforge/shared";

/**
 * The confirm/ask channels, reachable from something that was built before the
 * UI existed.
 *
 * The MCP clients are created at startup so their tools can be advertised to
 * the model, which is before the React app owns a way to put anything on
 * screen. A server can nevertheless ask us to run a model call or answer a
 * question — always during a run, and a run always has a live prompt. This
 * holder is what closes that gap: the app points it at the current run's
 * channels, and the MCP handlers read it when a request actually arrives.
 */
export type InteractiveChannels = {
  confirm: (request: PermissionRequest) => Promise<ConfirmResult>;
  askUser: (question: { question: string; options: string[]; freeText?: boolean }) => Promise<string>;
};

export type InteractiveChannelHolder = {
  /** Point the holder at the channels of the run that is starting. */
  bind(channels: InteractiveChannels): void;
  /** Release them when the run ends, so a late request is refused, not misrouted. */
  release(channels: InteractiveChannels): void;
  confirm: InteractiveChannels["confirm"];
  askUser: InteractiveChannels["askUser"];
};

const NO_RUN = "no agent run is active, so there is nobody to ask";

export function createInteractiveChannelHolder(): InteractiveChannelHolder {
  let current: InteractiveChannels | undefined;
  return {
    bind(channels) {
      current = channels;
    },
    release(channels) {
      // Only the run that bound them may release: a slower run finishing after
      // a newer one started must not unbind the newer one's channels.
      if (current === channels) current = undefined;
    },
    async confirm(request) {
      if (!current) throw new Error(NO_RUN);
      return current.confirm(request);
    },
    async askUser(question) {
      if (!current) throw new Error(NO_RUN);
      return current.askUser(question);
    },
  };
}
