FROM ubuntu

MAINTAINER Michael Elsdorfer <michael@elsdoerfer.com>

# Disables any interactive promps during install, such as from the `tzdata` package
ARG DEBIAN_FRONTEND=noninteractive


RUN apt-get update
RUN apt-get -y install sudo openssh-server git locales

RUN locale-gen en_US.UTF-8

# To avoid annoying "perl: warning: Setting locale failed." errors,
# do not allow the client to pass custom locals, see:
# http://stackoverflow.com/a/2510548/15677
RUN sed -i 's/^AcceptEnv LANG LC_\*$//g' /etc/ssh/sshd_config

RUN mkdir /var/run/sshd

RUN adduser --system --group --shell /bin/sh git
RUN su git -c "mkdir /home/git/bin"

RUN cd /home/git; su git -c "git clone git://github.com/sitaramc/gitolite";
RUN cd /home/git/gitolite; su git -c "git checkout v3.6.13";
RUN cd /home/git; su git -c "gitolite/install -ln";

# https://github.com/docker/docker/issues/5892
RUN chown -R git:git /home/git

# http://stackoverflow.com/questions/22547939/docker-gitlab-container-ssh-git-login-error
RUN sed -i '/session    required     pam_loginuid.so/d' /etc/pam.d/sshd

# Remove SSH host keys, so they will be generated by /init
RUN rm -f /etc/ssh/ssh_host_*

# Use dumb-init as PID1
ADD https://github.com/Yelp/dumb-init/releases/download/v1.2.2/dumb-init_1.2.2_amd64 /usr/sbin/init
RUN chmod +x /usr/sbin/init

# Our init script will do some setup work such as generating host keys on a per-container basis.
ADD ./init.sh /init
RUN chmod +x /init

ADD ./sshd_config /etc/ssh/sshd_config

# Make sure that the VOLUME intructions work on top of an existing directory which is already
# accessible by the "git" user (would be root otherwise).
RUN mkdir /home/git/repositories
RUN chown -R git:git /home/git/repositories

RUN chown -R git:git /etc/ssh
# Addind volume to repositories directory
VOLUME /home/git/repositories
VOLUME /etc/ssh


# Try to run this as non-root
USER git

ENTRYPOINT ["/usr/sbin/init"]
CMD ["/init", "/usr/sbin/sshd", "-D"]

EXPOSE 22
