# Image of the end-to-end runner: the official Playwright image (browsers, fonts and system libraries) plus the
# Playwright package of the same version. Built by test/e2e/run.ps1 as aantje-test-e2e-runner:<version>.
ARG PLAYWRIGHT_VERSION
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble

ARG PLAYWRIGHT_VERSION
WORKDIR /runner
# The package must match the browsers of the base image, hence the exact version.
RUN npm install --no-save --no-audit --no-fund @playwright/test@${PLAYWRIGHT_VERSION}
