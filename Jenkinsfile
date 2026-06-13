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
//   - ghcr-skyphusion       (User/pass)    ghcr.io pull creds (skyphusion-strummer + PAT);
//                                          used for authenticated pulls to avoid rate limits
//   - CLOUDFLARE_API_TOKEN  (Secret text)  Cloudflare API token with "Edit Workers" permissions
//   - CLOUDFLARE_ACCOUNT_ID (Secret text)  Cloudflare account ID
//   - D1_DATABASE_ID        (Secret text)  skyphusion-llm D1 database_id (not secret per se,
//                                          but account-specific; injected into wrangler.toml
//                                          from the wrangler.example.toml template at build time)
// Deploy never pushes Worker secrets (GATEWAY_ID, BYOK keys); those stay set on
// the Worker via `wrangler secret put` and are untouched by `wrangler deploy`.

pipeline {
  agent {
    docker {
      // Custom image: node:22 + Docker CLI + buildx, built/pushed on mindcrime-ci
      // (see ci/node-docker.Dockerfile). The Docker CLI lets the Deploy stage's
      // `wrangler deploy` build the three Cloudflare Container images
      // (containers/{audio-beat-sync,image-prep,video-finish}) before publishing.
      image 'ghcr.io/skyphusion-labs/ci-node-docker:latest'
      registryUrl 'https://ghcr.io'
      registryCredentialsId 'ghcr-skyphusion'
      // Bind-mount the host Docker socket and join the docker group by GID (988
      // on the fleet hosts) so wrangler's container builds reach the host daemon.
      // Docker Pipeline tokenizes args directly -- no shell evaluation -- so the
      // GID must be hardcoded; --group-add by name fails if the container has no
      // docker group entry in /etc/group. Still runs as the Jenkins uid, NOT root.
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
        CLOUDFLARE_ACCOUNT_ID = credentials('CLOUDFLARE_ACCOUNT_ID')
        D1_DATABASE_ID = credentials('D1_DATABASE_ID')
      }
      steps {
        // Build wrangler.toml from the committed template. wrangler.example.toml
        // ships with a PLACEHOLDER for database_id (intentional: new deployers must
        // provision their own D1). CI injects the real value from a secret credential
        // so the file never needs to live in the credential store as an opaque blob.
        // CLOUDFLARE_ACCOUNT_ID is picked up by wrangler from the env var directly.
        sh '''
          cp wrangler.example.toml wrangler.toml
          sed -i "s/PLACEHOLDER_RUN_wrangler_d1_create_THEN_PASTE_HERE/$D1_DATABASE_ID/" wrangler.toml
          npm run deploy
        '''
      }
      post {
        // Scrub the generated wrangler.toml. A stage-level post runs in the stage's
        // agent context, so it can't hit the missing-node-context error a top-level
        // post would if an earlier stage failed before the agent came up.
        always {
          sh 'rm -f wrangler.toml || true'
        }
      }
    }
  }

  post {
    // mail needs only a TaskListener (no node/workspace), so it is safe at the
    // top level even if a stage agent failed to come up (unlike sh). Sends via
    // the global Mailer (SMTP 127.0.0.1:2525 -> skyphusion-email relay).
    failure {
      mail to: 'conrad@rockenhaus.net',
           subject: "FAILED: ${env.JOB_NAME} #${env.BUILD_NUMBER}",
           body: "Build failed: ${env.BUILD_URL}"
    }
  }
}
