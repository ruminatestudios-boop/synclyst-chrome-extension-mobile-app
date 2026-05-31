## What does this change?

## Which parts does this touch?
- [ ] Frontend pages / UI (`auralink-ai/frontend/app/`)
- [ ] API routes (`auralink-ai/frontend/app/api/`)
- [ ] Backend Python (`auralink-ai/backend/`)
- [ ] VLM prompt (`vlm_prompt_template.py`)
- [ ] Quota / billing (`db.py`)
- [ ] Landing page (`public/landing.html`) ⚠️ do not modify without explicit approval
- [ ] Shared libs (`lib/`)

## Pre-merge checklist
- [ ] Tested locally
- [ ] If backend changed → redeploy Cloud Run after merge
- [ ] If VLM prompt changed → tested scan returns correct title/description/price
- [ ] If quota/billing changed → tested scan limit behaviour
- [ ] If `landing.html` touched → verified it still matches locked version
- [ ] No hardcoded secrets or API keys

## Risk level
- [ ] 🟢 Low — copy / styling
- [ ] 🟡 Medium — logic, non-critical path
- [ ] 🔴 High — scan flow, billing, VLM prompt, or landing page
