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
      image 'node:22'
      // Run as the Jenkins uid (the docker-pipeline default), NOT root. Running as
      // root made npm write root-owned files into the bind-mounted workspace
      // (.npm cache/logs, node_modules); the host `jenkins` user then could not
      // delete them on the next checkout, failing every subsequent build with
      // "Failed to clean the workspace / Operation not permitted". HOME below
      // points npm at a writable workspace dir, so it works fine as non-root.
    }
  }

  options {
    timeout(time: 20, unit: 'MINUTES')
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
      when {
        branch 'main'
        // Evaluate this guard BEFORE the input prompt; otherwise Jenkins prompts
        // for deploy approval on every branch/PR build (input runs before when by
        // default) and only skips the deploy steps after you approve.
        beforeInput true
      }
      // Manual gate: a human must click "Deploy" before production ships.
      // The 30-min timeout means an unattended build won't sit forever holding
      // the executor; it aborts the stage instead (build marked ABORTED, not FAILED).
      options {
        timeout(time: 30, unit: 'MINUTES')
      }
      input {
        message 'Deploy this commit to production?'
        ok 'Deploy'
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
