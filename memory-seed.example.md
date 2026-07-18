# Copy to memory-seed.md and replace with YOUR workspace facts.
# Each block between "---" lines becomes one memory record.
# Agents recall these automatically when a goal mentions related terms.
# Good seeds: service relationships, conventions, gotchas, ownership.

Our workspace has 20+ microservices. Frontends: 4 Angular apps. Backends: mostly
Node.js (Express), one NestJS service (gateway), one Java service (legacy).

---

gateway-svc (NestJS) is the only public entry point. It authenticates requests
via auth-svc (JWT) and routes to internal Node services over REST.

---

auth-svc issues JWTs consumed by all backend services. Its base URL is exposed
to other services as the env var AUTH_SERVICE_URL.

---

The Java service (legacy-billing) is maintenance-only. It exposes SOAP+REST and
is called by order-svc; do not propose new features there, only fixes.

---

Convention: all Node services keep routes in src/routes/, config in src/config/,
and use dotenv. Angular apps live in apps/ folders with shared UI in libs/.

---

Deployments go through GitHub Actions; each repo has .github/workflows/deploy.yml.
Staging deploys on merge to main, production is a manual approval.
