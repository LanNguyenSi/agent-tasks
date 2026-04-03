# Git Branch Configuration

This project uses **main** as the default branch.

## Branch Strategy

**Default Branch:** `main`

This branch name was auto-detected from the repository.

## CI/CD Integration

When setting up CI/CD workflows, ensure they target the correct branch:

```yaml
on:
  push:
    branches:
      - main
  pull_request:
    branches:
      - main
```

## Feature Branch Workflow

```bash
# Create feature branch
git checkout -b feat/my-feature

# Work on changes
git add .
git commit -m "feat: add new feature"

# Push and create PR
git push -u origin feat/my-feature

# After review, merge to main
```
