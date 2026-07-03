# SeekForge runner image (Track E: remote / isolated execution).
#
# Builds a minimal container that can execute one SeekForge task against a
# mounted workspace. Build it yourself — it is NOT built in CI/tests:
#
#   docker build -t seekforge-runner .
#
# Then run a task in isolation (see `seekforge sandbox-run --help` and
# docs/remote.md). The provider API key is passed at RUN time by env-var name,
# never baked into this image:
#
#   ARK_API_KEY=...  seekforge sandbox-run "fix the failing test"
#   # or, to inspect the exact docker command without running it:
#   seekforge sandbox-run "fix the failing test" --check
#
# Install source: by default this pulls the published `seekforge` from npm. To
# use a LOCAL build instead, build the CLI (`pnpm --filter seekforge build`),
# `npm pack` it, COPY the tarball in and `npm i -g ./seekforge-*.tgz`.
FROM node:20-slim

# git is commonly needed by agent tasks (status/diff/commit); keep the image lean.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Install the SeekForge CLI globally from npm (pin a version in production).
RUN npm install -g seekforge

# The workspace is bind-mounted here at run time (see buildDockerRunArgs).
WORKDIR /workspace

# The runner invokes `seekforge run <task> -y ...`; default to a help banner if
# run with no command so a bare `docker run seekforge-runner` is harmless.
ENTRYPOINT ["seekforge"]
CMD ["--help"]
