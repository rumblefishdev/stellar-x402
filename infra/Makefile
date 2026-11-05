# The AWS side of stellar-x402 (task 0027): three stacks, deployed by hand with SSO (decision 3).
# No workflow holds AWS credentials. Every deploy is agreed first: the account is shared.
#
#   aws sso login --profile stellar && export AWS_PROFILE=stellar
#
# The region comes from envs/production.json, never from --region on the command line.

REGION := $(shell node -p "require('./envs/production.json').awsRegion")
ENV := production
PREFIX := X402-$(ENV)
PRODUCTION_APP := node dist/bin/production.js
CDK := pnpm exec cdk --app "$(PRODUCTION_APP)"

.PHONY: build bootstrap synth-production diff-production deploy-production \
	diff-production-telemetry deploy-production-telemetry \
	diff-production-uptime deploy-production-uptime \
	diff-production-alarms deploy-production-alarms \
	fire-test check-series check-emf-disabled telemetry-arns

# The catalog and the config package first: turbo builds what infra imports.
build:
	cd .. && pnpm exec turbo run build --filter=@stellar-x402/infra

# The account already has the default bootstrap, with no qualifier of our own (decision 3), so
# this is for a fresh account only. A bare `cdk bootstrap` synthesizes the app first; the no-op
# app and the explicit environment skip that (the Prices API's 0297).
bootstrap:
	pnpm exec cdk bootstrap --app "node -e ''" \
		aws://$$(aws sts get-caller-identity --query Account --output text)/$(REGION)

# Needs no AWS access: the SSM values are resolved by CloudFormation at deploy.
synth-production: build
	$(CDK) synth --quiet

# --strict: without it cdk diff hides entries with non-ASCII characters, so a clean-looking diff
# is no proof of a clean diff (the explorer's 0312).
diff-production: build
	$(CDK) diff --strict

# A deploy of all stacks ships every pending change, a parked one too (the explorer's 0312
# "stowaway"), so the full diff is printed first, into the same output. --require-approval
# broadening stops on IAM widening only: read the diff for removals too (the Prices API's 0157).
deploy-production: build
	$(CDK) diff --strict
	$(CDK) deploy --all --require-approval broadening
	@echo "Now: make fire-test, and wait for a person to see it in #stellar-x402-bot."

# One stack each, --exclusively: no stack imports from another (decision 27), and without the
# flag a deploy also deploys the stacks it depends on (the Prices API's 0141).
diff-production-telemetry: build
	$(CDK) diff --strict $(PREFIX)-Telemetry

deploy-production-telemetry: build
	$(CDK) diff --strict $(PREFIX)-Telemetry
	$(CDK) deploy $(PREFIX)-Telemetry --exclusively --require-approval broadening
	@$(MAKE) --no-print-directory telemetry-arns

diff-production-uptime: build
	$(CDK) diff --strict $(PREFIX)-Uptime

deploy-production-uptime: build
	$(CDK) diff --strict $(PREFIX)-Uptime
	$(CDK) deploy $(PREFIX)-Uptime --exclusively --require-approval broadening

diff-production-alarms: build
	$(CDK) diff --strict $(PREFIX)-Alarms

deploy-production-alarms: build
	$(CDK) diff --strict $(PREFIX)-Alarms
	$(CDK) deploy $(PREFIX)-Alarms --exclusively --require-approval broadening
	@echo "Now: make fire-test, and wait for a person to see it in #stellar-x402-bot."

# The delivery test, after every deploy of the alarms (ADR 0011, decision 12): done only when a
# person sees the message in Slack. The default alarm reads a metric written only on a failure,
# so its next evaluation puts it back to OK, and it sends no OK message. The history then shows
# whether SNS took the action: a refused publish shows only there (the explorer's 2026-08-27).
ALARM ?= x402-$(ENV)-emf-validation
fire-test:
	aws cloudwatch set-alarm-state --region $(REGION) --alarm-name "$(ALARM)" \
		--state-value ALARM --state-reason "Delivery test (make fire-test): no fault, confirm it in Slack"
	@echo "Sent. Waiting 30 s for the action's result."
	@sleep 30
	aws cloudwatch describe-alarm-history --region $(REGION) --alarm-name "$(ALARM)" \
		--history-item-type Action --max-records 3 \
		--query 'AlarmHistoryItems[].[Timestamp,HistorySummary]' --output table

# Before a group goes on: every series it reads that is written all the time has data
# (decision 26). GROUP is one of the alarmGroups in envs/production.json.
check-series: build
	@test -n "$(GROUP)" || { echo "usage: make check-series GROUP=<group>" >&2; exit 2; }
	node dist/bin/check-series.js $(GROUP)

# Once, when the alarms first go on: EMF lines are ignored when an account policy of type
# METRIC_EXTRACTION_POLICY matches the group, and EMFDisabledErrors counts them. Expect no policy
# that matches /x402/$(ENV)/metrics, and no EMFDisabledErrors.
check-emf-disabled:
	aws logs describe-account-policies --region $(REGION) --policy-type METRIC_EXTRACTION_POLICY \
		--query 'accountPolicies[].[policyName,scope,selectionCriteria]' --output table
	aws cloudwatch get-metric-statistics --region $(REGION) --namespace AWS/Logs \
		--metric-name EMFDisabledErrors --dimensions Name=LogGroupName,Value=/x402/$(ENV)/metrics \
		--statistics Sum --period 86400 \
		--start-time $$(node -e 'console.log(new Date(Date.now() - 14 * 864e5).toISOString())') \
		--end-time $$(node -e 'console.log(new Date().toISOString())') \
		--query 'Datapoints[].[Timestamp,Sum]' --output table

# The three ARNs the agent's credential helper on the server is started with (#113).
telemetry-arns:
	aws cloudformation describe-stacks --region $(REGION) --stack-name $(PREFIX)-Telemetry \
		--query 'Stacks[0].Outputs[].[OutputKey,OutputValue]' --output table
