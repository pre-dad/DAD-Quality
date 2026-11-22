export const POSTGRES = 'postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea';
export const NGINX = 'nginx:1.30.5-alpine@sha256:0985e772fb9f729e6fa0980da05fca5d9c468e870eed43071545afa9d2e27d94';

export const nginxConf = `server {\n listen 8080;\n server_name _;\n location / {\n  proxy_pass http://web:3000;\n  proxy_set_header Host $http_host;\n  proxy_set_header X-Forwarded-Proto $scheme;\n  proxy_set_header X-Forwarded-For $remote_addr;\n }\n}\n`;

export function composeDefinition({ id, port, password, apiPassword, staffPassword }) {
  const publicOrigin = `http://localhost:${port}`,
    staffOrigin = `http://staff.localhost:${port}`;
  const common = {
    DONOR_PUBLIC_ORIGIN: publicOrigin,
    DONOR_STAFF_ORIGIN: staffOrigin,
    DONOR_GO_WORKERS_ENABLED: 'false',
  };
  const base = {
    networks: ['isolated'],
    labels: { 'atm.run': id },
    security_opt: ['no-new-privileges:true'],
    cap_drop: ['ALL'],
  };
  return {
    name: id,
    services: {
      postgres: {
        ...base,
        image: POSTGRES,
        environment: { POSTGRES_USER: 'atm_owner', POSTGRES_PASSWORD: password, POSTGRES_DB: 'dad_atm' },
        tmpfs: ['/var/lib/postgresql/data'],
        healthcheck: {
          test: ['CMD-SHELL', 'pg_isready -U atm_owner -d dad_atm'],
          interval: '2s',
          timeout: '2s',
          retries: 30,
        },
        cap_drop: [],
        security_opt: [],
      },
      'test-postgres': {
        ...base,
        image: POSTGRES,
        environment: { POSTGRES_USER: 'atm_owner', POSTGRES_PASSWORD: password, POSTGRES_DB: 'donor_go' },
        tmpfs: ['/var/lib/postgresql/data'],
        healthcheck: {
          test: ['CMD-SHELL', 'pg_isready -U atm_owner -d donor_go'],
          interval: '2s',
          timeout: '2s',
          retries: 30,
        },
        cap_drop: [],
        security_opt: [],
      },
      migrate: {
        ...base,
        image: `${id}/api:local`,
        command: ['migrate'],
        environment: { DONOR_GO_DATABASE_URL: `postgresql://atm_owner:${password}@postgres/dad_atm?sslmode=disable` },
      },
      api: {
        ...base,
        image: `${id}/api:local`,
        environment: {
          ...common,
          DONOR_API_DATABASE_URL: `postgresql://atm_api:${apiPassword}@postgres/dad_atm?sslmode=disable`,
        },
        read_only: true,
        tmpfs: ['/tmp'],
        healthcheck: {
          test: ['CMD', 'wget', '-q', '-O', '/dev/null', 'http://127.0.0.1:8002/health/ready'],
          interval: '2s',
          timeout: '3s',
          retries: 30,
        },
      },
      web: {
        ...base,
        image: `${id}/web:local`,
        environment: { ...common, DONOR_API_BASE_URL: 'http://api:8002' },
        tmpfs: ['/tmp', '/app/.next/cache'],
      },
      ingress: {
        image: NGINX,
        labels: { 'atm.run': id },
        security_opt: ['no-new-privileges:true'],
        cap_drop: ['ALL'],
        cap_add: ['CHOWN', 'SETGID', 'SETUID', 'NET_BIND_SERVICE'],
        networks: ['isolated', 'edge'],
        ports: [`127.0.0.1:${port}:8080`],
        volumes: ['./nginx.conf:/etc/nginx/conf.d/default.conf:ro'],
        healthcheck: {
          test: ['CMD', 'wget', '-q', '-O', '/dev/null', 'http://127.0.0.1:8080/'],
          interval: '2s',
          timeout: '3s',
          retries: 30,
        },
      },
      staff: {
        ...base,
        image: `${id}/api:local`,
        entrypoint: ['staff'],
        environment: {
          ...common,
          DONOR_STAFF_CLI_DATABASE_URL: `postgresql://atm_staff:${staffPassword}@postgres/dad_atm?sslmode=disable`,
        },
      },
      'api-tests': {
        ...base,
        image: `${id}/api-checks:local`,
        environment: { TEST_DATABASE_URL: `postgresql://atm_owner:${password}@test-postgres/donor_go?sslmode=disable` },
        command: ['sh', '-c', 'go vet ./... && go test -race ./...'],
        working_dir: '/src',
      },
      'web-tests': {
        ...base,
        image: `${id}/web-checks:local`,
        command: ['sh', '-c', 'npm run lint -- --vcs-enabled=false && npm test -- --run && npm run typecheck'],
        working_dir: '/app',
      },
    },
    networks: { isolated: { internal: true }, edge: {} },
  };
}
