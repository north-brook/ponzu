# The image every design's Vercel Sandbox starts from, pushed to the ponzu-api project's Vercel
# Container Registry as ponzu-runner and named by digest in current.json (build.ts builds it
# from a folder it stages). Ubuntu 24.04, not Vercel's 26.04 base, because the font pins in
# packages/render/sandbox-fonts.json are 24.04's. Vercel runs no ENTRYPOINT or CMD: the API
# runs /opt/ponzu/bin/ponzu-start at every start.
FROM ubuntu:24.04@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852

ENV LANG=C.UTF-8
COPY . /tmp/recipe
RUN bash /tmp/recipe/provision.sh && rm -rf /tmp/recipe

ENV HOME=/vercel
ENV SHELL=/bin/bash
ENV PATH=/opt/ponzu/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
USER ubuntu
WORKDIR /vercel
