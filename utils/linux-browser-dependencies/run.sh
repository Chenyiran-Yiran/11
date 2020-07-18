#!/bin/bash
set -e
set +x

if [[ ($1 == '--help') || ($1 == '-h') ]]; then
  echo "usage: $(basename $0) <image-name>"
  echo
  echo "List mapping between browser dependencies to package names and save results in RUN_RESULT file."
  echo "Example:"
  echo ""
  echo "  $(basename $0) ubuntu:bionic"
  echo ""
  echo "NOTE: this requires Playwright dependencies to be installed with 'npm install'"
  echo "      and Playwright itself being built with 'npm run build'"
  echo ""
  exit 0
fi

if [[ $# == 0 ]]; then
  echo "ERROR: please provide base image name, e.g. 'ubuntu:bionic'"
  exit 1
fi

function cleanup() {
  rm -f "playwright.tar.gz"
}

trap "cleanup; cd $(pwd -P)" EXIT
cd "$(dirname "$0")"

# We rely on `./playwright.tar.gz` to download browsers into the docker image.
node ../../packages/build_package.js playwright ./playwright.tar.gz

docker run -v $PWD:/root/hostfolder --rm -it "$1" /root/hostfolder/inside_docker/process.sh

