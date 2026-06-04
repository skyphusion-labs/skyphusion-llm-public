// Jenkins pipeline for skyphusion-llm-public.
// Mirrors .github/workflows/ci.yml (install -> typecheck -> test) and adds a
// deploy stage gated to the main branch. Runs inside a node:22 Docker container
// so the box only needs Docker + the Docker Pipeline plugin (no host Node).
//
// SECURITY: this repo is PUBLIC and the agent is self-hosted. If you wire this up
// as a multibranch/GitHub job, do NOT let untrusted fork PRs build on the box
// (set the branch source to "Exclude branches that are also filed as PRs" and
// disable "Discover pull requests from forks", mirroring the fork guard in ci.yml).
//
// Required Jenkins credentials (Manage Jenkins -> Credentials):
//   - skyphusion-wrangler-toml  (Secret file)   the real wrangler.toml with
//                                                database_id + account_id filled in
//   - CLOUDFLARE_API_TOKEN      (Secret text)   Cloudflare API token with
//                                                "Edit Workers" permissions
//                                                (already present on mindcrime-ci)
// Deploy never pushes Worker secrets (GATEWAY_ID, BYOK keys); those stay set on
// the Worker via `wrangler secret put` and are untouched by `wrangler deploy`.

pipeline {
  agent {
    docker {
      // Custom image: node:22 + Docker CLI + buildx, built/pushed on mindcrime-ci
      // (see ci/node-docker.Dockerfile). The Docker CLI lets the Deploy stage's
      // `wrangler deploy` build the three Cloudflare Container images
      // (containers/{audio-beat-sync,image-prep,video-finish}) before publishing.
      image 'ghcr.io/skyphusion/ci-node-docker:latest'
      // Bind-mount the host Docker socket and join the `docker` group (gid 988 on
      // mindcrime-ci, per `id jenkins`) so wrangler's container builds reach the
      // host daemon. Still runs as the Jenkins uid (the docker-pipeline default),
      // NOT root: running as root made npm write root-owned files into the
      // workspace that the host jenkins user then could not clean on the next
      // checkout. HOME below points npm at a writable workspace dir.
      args '-v /var/run/docker.sock:/var/run/docker.sock --group-add 988'
    }
  }

  options {
    // Generous: a full deploy rebuilds the three Cloudflare Container images,
    // which can take several minutes each on a cold layer cache.
    timeout(time: 60, unit: 'MINUTES')
    disableConcurrentBuilds()
    timestamps()                 // requires the Timestamper plugin (ships by default)
    buildDiscarder(logRotator(numToKeepStr: '30'))
  }

  environment {
    // Keep npm's cache and HOME inside the workspace (writable, cleaned per build).
    HOME = "${env.WORKSPACE}"
    npm_config_cache = "${env.WORKSPACE}/.npm"
    CI = 'true'
  }

  stages {
    stage('Install') {
      steps {
        sh 'node --version && npm --version'
        sh 'npm ci'
      }
    }

    stage('Typecheck') {
      steps {
        sh 'npm run typecheck'
      }
    }

    stage('Test') {
      steps {
        sh 'npm test'
      }
    }

    stage('Deploy') {
      // Auto-deploy: every green build on `main` ships to production. CI must pass
      // first (a failing typecheck or test never reaches this stage), so there is
      // no manual approval gate. PR/branch builds are excluded by the `when` below.
      when {
        branch 'main'
      }
      environment {
        CLOUDFLARE_API_TOKEN = credentials('CLOUDFLARE_API_TOKEN')
      }
      steps {
        // wrangler.toml is gitignored, so inject the real one from a Secret file
        // credential before deploying. account_id lives inside that file.
        withCredentials([file(credentialsId: 'skyphusion-wrangler-toml', variable: 'WRANGLER_TOML')]) {
          sh 'cp "$WRANGLER_TOML" wrangler.toml'
          sh 'npm run deploy'
        }
      }
      post {
        // Scrub the injected secret file. A stage-level post runs in the stage's
        // agent context, so it can't hit the missing-node-context error a top-level
        // post would if an earlier stage failed before the agent came up. The git
        // checkout wipes the rest of the workspace at the start of each build.
        always {
          sh 'rm -f wrangler.toml || true'
        }
      }
    }
  }
}
