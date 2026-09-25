#!/bin/sh
set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
base_image=docker.io/library/node@sha256:6642ef280aebc09c4541bee0b15c9f89f0f3f3c247ddee79ae1d37eddfdcbbaa
base_digest=sha256:6642ef280aebc09c4541bee0b15c9f89f0f3f3c247ddee79ae1d37eddfdcbbaa
image_tag=localhost/pluxel-rpc-executor:node-24.20.0
containerfile="$repository_root/engineering/rpc-executor-image/Containerfile"

test "$(sed -n 's/^FROM //p' "$containerfile")" = "$base_image"

docker pull --platform linux/amd64 "$base_image"
test "$(docker image inspect "$base_image" --format '{{.Digest}}')" = "$base_digest"
test "$(docker image inspect "$base_image" --format '{{.Os}}/{{.Architecture}}')" = linux/amd64

docker build --pull=never --platform linux/amd64 \
	--file "$containerfile" \
	--tag "$image_tag" \
	"$repository_root/engineering/rpc-executor-image"

image_id=$(docker image inspect "$image_tag" --format '{{.Id}}')
test "$(docker image inspect "$image_id" --format '{{.Os}}/{{.Architecture}}')" = linux/amd64
test "$(docker image inspect "$image_id" --format '{{.Config.User}}')" = 1001:1001
test "$(docker image inspect "$image_id" --format '{{json .RootFS.Layers}}')" = \
	"$(docker image inspect "$base_image" --format '{{json .RootFS.Layers}}')"
docker run --rm --pull=never --network=none --read-only "$image_id" node -e \
	'if (process.version !== "v24.20.0" || process.getuid() !== 1001 || process.getgid() !== 1001) process.exit(1)'

printf 'RPC executor local image ID: %s\n' "$image_id"
RPC_SANDBOX_IMAGE="$image_id" pnpm --dir "$repository_root" --filter @pluxel/services exec vitest run \
	tests/services/rpc-executor.test.ts tests/services/rpc-http.test.ts
