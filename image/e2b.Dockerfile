# The E2B toolchain template — the same environment as image/Dockerfile,
# without Heyo's boot plumbing (no sshd, socat, e2fsprogs, or /init.sh).
#
# Build and publish it with:
#   E2B_API_KEY=... node image/build-e2b.mjs
# then set E2B_TEMPLATE=sailor-toolchain:latest in .env.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget git openssh-client \
      build-essential pkg-config cmake \
      python3 python3-pip python3-venv python3-dev \
      jq unzip zip less openssl tar procps \
      ripgrep fd-find \
    && rm -rf /var/lib/apt/lists/*

# Ubuntu marks the system Python as externally managed (PEP 668); an agent
# wants `pip install -r requirements.txt` to just work.
RUN rm -f /usr/lib/python3.*/EXTERNALLY-MANAGED \
    && ln -sf /usr/bin/python3 /usr/local/bin/python \
    && python3 -m pip install --no-cache-dir pytest

RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable

RUN ln -sf /usr/bin/fdfind /usr/local/bin/fd \
    && git config --system init.defaultBranch main

WORKDIR /home/user
