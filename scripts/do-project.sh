#!/usr/bin/env bash
# Creates the DigitalOcean project that groups the cluster, the load balancer and the Spaces
# bucket (#53), or finds it by name. Repeatable: a second run changes nothing (INF-3).
# A project is a label, not a billable resource. Needs doctl, authenticated with `doctl auth init`.
set -euo pipefail

: "${PROJECT_NAME:=ContentCollab}"
: "${ENVIRONMENT:=Development}"   # Development, Staging or Production (doctl projects create)
: "${PURPOSE:=Web Application}"   # the value DigitalOcean's own Terraform example uses

[[ "$PROJECT_NAME" =~ ^[A-Za-z0-9-]+$ ]] || { echo "PROJECT_NAME may contain letters, digits and dashes only"; exit 1; }
case "$ENVIRONMENT" in
  Development|Staging|Production) ;;
  *) echo "ENVIRONMENT must be Development, Staging or Production"; exit 1 ;;
esac
command -v doctl >/dev/null || { echo "missing: doctl"; exit 1; }
doctl account get >/dev/null 2>&1 || { echo "doctl is not authenticated: run \`doctl auth init\`"; exit 1; }

# The exact name, not a prefix: ContentCollab-old is another project
projects=$(doctl projects list --format ID,Name --no-header)
id=$(printf '%s\n' "$projects" | awk -v name="$PROJECT_NAME" '$2 == name { print $1; exit }')

if [ -z "$id" ]; then
  id=$(doctl projects create --name "$PROJECT_NAME" --purpose "$PURPOSE" --environment "$ENVIRONMENT" \
    --description "ECE1779 Team 22: ContentCollab cluster, load balancer and Spaces bucket" \
    --format ID --no-header)
  echo "created project"
else
  echo "found project"
fi
echo "$PROJECT_NAME: $id"
echo "Next: create the Spaces bucket in the Control Panel and pick this project in the form (k8s/README.md)."
