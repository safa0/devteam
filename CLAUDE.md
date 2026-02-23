# Freely - AI Assistant Desktop App

## Team Agents

This repo is configured with a multi-agent dev team. Use the appropriate specialist agent for each task:

| Agent | Role | Use For |
|-------|------|---------|
| `team-lead` | Architecture & coordination | Code review, architecture decisions, cross-team coordination |
| `aws-specialist` | AWS infrastructure | CDK, Terraform, S3, SageMaker, Lambda, cost optimization |
| `backend-dev` | Server-side development | APIs, authentication, MCP servers, Node/Python backends |
| `frontend-dev` | UI development | React, Next.js, Tailwind, component architecture |
| `db-specialist` | Database engineering | PostgreSQL, schema design, migrations, query optimization |
| `typescript-dev` | TypeScript expertise | Type system, toolchain, NestJS, enterprise patterns |
| `rust-dev` | Rust development | Systems programming, performance, safety |
| `test-dev` | Testing | Unit, integration, E2E testing strategy and implementation |
| `github-ops` | GitHub workflows | PRs, issues, CI/CD, GitHub API operations |

## Conventions

- Use CDK (TypeScript) as default for AWS infrastructure unless otherwise specified
- Follow AWS Well-Architected Framework principles
- Tag all AWS resources for cost allocation
- Apply least-privilege IAM policies
- Prefer serverless for variable workloads

## Project Structure

```
.claude/
  agents/           # Agent definitions and their skills
    aws-specialist/ # AWS CDK, cost ops, Terraform skills
    backend-dev/    # MCP builder, GitHub ops skills
    frontend-dev/   # Frontend design, web artifacts, webapp testing
    db-specialist/  # PostgreSQL, pg-aiguide skills
    rust-dev/       # Rust skills collection
    test-dev/       # Unit, E2E, webapp testing skills
    team-lead/      # Code review skills
    typescript-dev/ # TypeScript mastery skills
    github-ops/     # GitHub operations skills
```

