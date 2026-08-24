# syntax=docker/dockerfile:1
# The base image, Ubuntu package archive, and Gitolite revision are intentionally
# pinned. See README.md for the refresh policy.
FROM ubuntu:26.04@sha256:2260313b31c8c011cd2eebe728008efac1b3982be73eb71348ea2648d2c0e09b

LABEL org.opencontainers.image.title="docker-gitolite" \
      org.opencontainers.image.source="https://github.com/miracle2k/docker-gitolite"

# Avoid interactive package configuration during the image build.
ARG DEBIAN_FRONTEND=noninteractive
# Ubuntu snapshot containing the complete direct and transitive package set.
ARG APT_SNAPSHOT=20260822T000000Z
ARG GITOLITE_VERSION=v3.6.15
# Annotated tag v3.6.15 resolves to this immutable commit.
ARG GITOLITE_COMMIT=782b05fece05e10f21ce2ed0ba308a8e23f151c2

ENV HOME=/home/git \
    LANG=en_US.UTF-8 \
    LC_ALL=en_US.UTF-8

# The minimal Ubuntu base does not contain CA roots. Bootstrap them from the
# signed canonical archive before switching apt to the HTTPS snapshot service.
# Keeping Snapshot in the image prevents later apt invocations from drifting.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && sed -i "/^Signed-By:/a Snapshot: ${APT_SNAPSHOT}" /etc/apt/sources.list.d/ubuntu.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        dumb-init \
        git \
        locales \
        openssh-server \
    && rm -rf /var/lib/apt/lists/*

RUN locale-gen en_US.UTF-8

# Keep the numerical account identity stable for existing installations with
# persisted repositories and SSH-host-key volumes.
RUN addgroup --system --gid 107 git \
    && adduser --system --uid 106 --ingroup git --home /home/git --shell /bin/sh git \
    && install -d -o git -g git -m 0755 /home/git /home/git/bin /home/git/repositories \
    && install -d -m 0755 /run/sshd

# Verify the Gitolite tag resolves to the reviewed commit before installing it.
RUN su git -s /bin/sh -c "git clone --depth 1 --branch '${GITOLITE_VERSION}' https://github.com/sitaramc/gitolite.git /home/git/gitolite" \
    && su git -s /bin/sh -c "test \"\$(git -C /home/git/gitolite rev-parse HEAD)\" = \"${GITOLITE_COMMIT}\"" \
    && su git -s /bin/sh -c '/home/git/gitolite/install -ln' \
    && rm -rf /home/git/gitolite/.git

COPY init.sh /init
# Keep the managed config outside the host-key volume so upgrades cannot use a
# stale sshd_config from an existing /etc/ssh volume.
COPY sshd_config /usr/local/etc/sshd_config

# Fail the build for an invalid OpenSSH configuration. Host keys are generated
# at container start so that every deployment gets its own identity.
RUN chmod 0755 /init \
    && ssh-keygen -A \
    && sshd -t -f /usr/local/etc/sshd_config \
    && chown -R git:git /etc/ssh /home/git \
    && su git -s /bin/sh -c 'sshd -t -f /usr/local/etc/sshd_config' \
    && rm -f /etc/ssh/ssh_host_*

# Preserve the directories that contain persistent repositories and host keys.
VOLUME /home/git/repositories
VOLUME /etc/ssh

# sshd itself runs without root privileges on the unprivileged port below.
USER git

ENTRYPOINT ["/usr/bin/dumb-init", "--", "/init"]
CMD ["/usr/sbin/sshd", "-D", "-f", "/usr/local/etc/sshd_config"]

EXPOSE 2222
