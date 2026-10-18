# The sandbox toolchain image (step 16) — what every Agent-run VM boots with.
#
# A generic agent working environment: git, Python 3 (+pip/venv/pytest),
# Node 22 (+npm/corepack), ripgrep, jq, and a native build toolchain so
# `pip install -r requirements.txt` and `npm install` work without an
# apt-get storm on every boot. Built and published with image/build.sh.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget git openssh-client \
      build-essential pkg-config cmake \
      python3 python3-pip python3-venv python3-dev \
      jq unzip zip less procps openssl tar \
      ripgrep fd-find \
    && rm -rf /var/lib/apt/lists/*

# Ubuntu marks the system Python as externally managed (PEP 668); an agent VM
# wants `pip install -r requirements.txt` to just work. Drop the marker and
# pre-seed the one runner almost every Python repo needs.
RUN rm -f /usr/lib/python3.*/EXTERNALLY-MANAGED \
    && ln -sf /usr/bin/python3 /usr/local/bin/python \
    && python3 -m pip install --no-cache-dir pytest

# Node 22 (LTS) — Ubuntu's nodejs package is too old for modern toolchains.
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable

# Ubuntu's fd package installs `fdfind`; agents and scripts expect `fd`.
RUN ln -sf /usr/bin/fdfind /usr/local/bin/fd \
    && git config --system init.defaultBranch main
