import { pushEvent } from "./gtag";

// ─── Event Name Constants ───────────────────────────────────────────

export const EventNames = {
  // Auth
  SIGN_UP: "sign_up",
  LOGIN: "login",
  LOGOUT: "logout",

  // Onboarding
  ONBOARDING_START: "onboarding_start",
  ONBOARDING_STEP_COMPLETE: "onboarding_step_complete",
  ONBOARDING_WEBSITE_SCAN: "onboarding_website_scan",
  ONBOARDING_VOICE_PREVIEW: "onboarding_voice_preview",
  ONBOARDING_TEST_CALL_START: "onboarding_test_call_start",
  ONBOARDING_TEST_CALL_COMPLETE: "onboarding_test_call_complete",
  ONBOARDING_PLAN_SELECTED: "onboarding_plan_selected",
  ONBOARDING_COMPLETE: "onboarding_complete",

  // Core Product
  ASSISTANT_CREATED: "assistant_created",
  ASSISTANT_UPDATED: "assistant_updated",
  ASSISTANT_DELETED: "assistant_deleted",
  ASSISTANT_TOGGLED: "assistant_toggled",
  TEST_CALL_STARTED: "test_call_started",
  TEST_CALL_COMPLETED: "test_call_completed",
  PHONE_NUMBER_ADDED: "phone_number_added",
  PHONE_NUMBER_REMOVED: "phone_number_removed",
  AI_TOGGLE_CHANGED: "ai_toggle_changed",
  TRANSFER_RULE_CREATED: "transfer_rule_created",
  TRANSFER_RULE_UPDATED: "transfer_rule_updated",
  TRANSFER_RULE_DELETED: "transfer_rule_deleted",
  TEMPLATE_APPLIED: "template_applied",

  // Knowledge & Settings
  KNOWLEDGE_ENTRY_ADDED: "knowledge_entry_added",
  KNOWLEDGE_ENTRY_DELETED: "knowledge_entry_deleted",
  NOTIFICATION_PREFS_UPDATED: "notification_preferences_updated",
  WEBHOOK_CREATED: "webhook_created",
  WEBHOOK_TESTED: "webhook_tested",
  CALENDAR_CONNECTED: "calendar_connected",
  CALENDAR_DISCONNECTED: "calendar_disconnected",
  TEAM_MEMBER_INVITED: "team_member_invited",
  TEAM_MEMBER_REMOVED: "team_member_removed",

  // Billing & Conversion (GA4 recommended ecommerce events)
  BILLING_PAGE_VIEWED: "billing_page_viewed",
  BEGIN_CHECKOUT: "begin_checkout",
  PURCHASE: "purchase",
  PLAN_UPGRADE_CLICKED: "plan_upgrade_clicked",
  PLAN_DOWNGRADE_CLICKED: "plan_downgrade_clicked",

  // Engagement
  CALL_LOG_VIEWED: "call_log_viewed",
  CALL_DETAIL_VIEWED: "call_detail_viewed",
  ANALYTICS_EXPORT: "analytics_export",
  DEMO_CALL_STARTED: "demo_call_started",
  DEMO_CALL_COMPLETED: "demo_call_completed",
  ROI_CALCULATOR_USED: "roi_calculator_used",

  // Marketing
  CTA_CLICKED: "cta_clicked",
  PRICING_PAGE_VIEWED: "pricing_page_viewed",
  INDUSTRY_PAGE_VIEWED: "industry_page_viewed",
} as const;

export type EventName = (typeof EventNames)[keyof typeof EventNames];

// ─── Auth ───────────────────────────────────────────────────────────

export function trackSignUp(method: "google" | "email"): void {
  pushEvent(EventNames.SIGN_UP, { method });
}

export function trackLogin(method: "google" | "email"): void {
  pushEvent(EventNames.LOGIN, { method });
}

export function trackLogout(): void {
  pushEvent(EventNames.LOGOUT);
}

// ─── Onboarding ─────────────────────────────────────────────────────

export function trackOnboardingStart(): void {
  pushEvent(EventNames.ONBOARDING_START);
}

export function trackOnboardingStepComplete(step: number, stepName: string): void {
  pushEvent(EventNames.ONBOARDING_STEP_COMPLETE, {
    step,
    step_name: stepName,
  });
}

export function trackOnboardingWebsiteScan(success: boolean): void {
  pushEvent(EventNames.ONBOARDING_WEBSITE_SCAN, { success });
}

export function trackOnboardingVoicePreview(voiceId: string): void {
  pushEvent(EventNames.ONBOARDING_VOICE_PREVIEW, { voice_id: voiceId });
}

export function trackOnboardingTestCallStart(): void {
  pushEvent(EventNames.ONBOARDING_TEST_CALL_START);
}

export function trackOnboardingTestCallComplete(): void {
  pushEvent(EventNames.ONBOARDING_TEST_CALL_COMPLETE);
}

export function trackOnboardingPlanSelected(planType: string): void {
  pushEvent(EventNames.ONBOARDING_PLAN_SELECTED, { plan_type: planType });
}

export function trackOnboardingComplete(planType: string, industry: string): void {
  pushEvent(EventNames.ONBOARDING_COMPLETE, {
    plan_type: planType,
    industry,
  });
}

// ─── Core Product ───────────────────────────────────────────────────

export function trackAssistantCreated(industry?: string): void {
  pushEvent(EventNames.ASSISTANT_CREATED, { industry });
}

export function trackAssistantUpdated(fieldChanged: string): void {
  pushEvent(EventNames.ASSISTANT_UPDATED, { field_changed: fieldChanged });
}

export function trackAssistantDeleted(): void {
  pushEvent(EventNames.ASSISTANT_DELETED);
}

export function trackTestCallStarted(source: "dashboard" | "onboarding"): void {
  pushEvent(EventNames.TEST_CALL_STARTED, { source });
}

export function trackTestCallCompleted(
  durationSeconds: number,
  source: "dashboard" | "onboarding"
): void {
  pushEvent(EventNames.TEST_CALL_COMPLETED, {
    duration_seconds: durationSeconds,
    source,
  });
}

export function trackPhoneNumberAdded(
  type: "purchased" | "forwarded",
  country: string
): void {
  pushEvent(EventNames.PHONE_NUMBER_ADDED, { type, country });
}

export function trackPhoneNumberRemoved(): void {
  pushEvent(EventNames.PHONE_NUMBER_REMOVED);
}

export function trackAiToggleChanged(enabled: boolean): void {
  pushEvent(EventNames.AI_TOGGLE_CHANGED, { enabled });
}

export function trackTransferRuleCreated(): void {
  pushEvent(EventNames.TRANSFER_RULE_CREATED);
}

export function trackTransferRuleUpdated(): void {
  pushEvent(EventNames.TRANSFER_RULE_UPDATED);
}

export function trackTransferRuleDeleted(): void {
  pushEvent(EventNames.TRANSFER_RULE_DELETED);
}

export function trackTemplateApplied(industry: string): void {
  pushEvent(EventNames.TEMPLATE_APPLIED, { industry });
}

// ─── Knowledge & Settings ───────────────────────────────────────────

export function trackKnowledgeEntryAdded(sourceType: string): void {
  pushEvent(EventNames.KNOWLEDGE_ENTRY_ADDED, { source_type: sourceType });
}

export function trackKnowledgeEntryDeleted(): void {
  pushEvent(EventNames.KNOWLEDGE_ENTRY_DELETED);
}

export function trackNotificationPrefsUpdated(): void {
  pushEvent(EventNames.NOTIFICATION_PREFS_UPDATED);
}

export function trackWebhookCreated(): void {
  pushEvent(EventNames.WEBHOOK_CREATED);
}

export function trackWebhookTested(): void {
  pushEvent(EventNames.WEBHOOK_TESTED);
}

export function trackCalendarConnected(): void {
  pushEvent(EventNames.CALENDAR_CONNECTED);
}

export function trackCalendarDisconnected(): void {
  pushEvent(EventNames.CALENDAR_DISCONNECTED);
}

export function trackTeamMemberInvited(): void {
  pushEvent(EventNames.TEAM_MEMBER_INVITED);
}

export function trackTeamMemberRemoved(): void {
  pushEvent(EventNames.TEAM_MEMBER_REMOVED);
}

// ─── Billing & Conversion ───────────────────────────────────────────

export function trackBeginCheckout(planType: string, valueCents: number): void {
  const valueDollars = valueCents / 100;
  pushEvent(EventNames.BEGIN_CHECKOUT, {
    currency: "AUD",
    value: valueDollars,
    items: [
      {
        item_id: planType,
        item_name: `${planType}_plan`,
        price: valueDollars,
      },
    ],
  });
}

export function trackPurchase(
  planType: string,
  valueCents: number,
  transactionId?: string
): void {
  const valueDollars = valueCents / 100;
  pushEvent(EventNames.PURCHASE, {
    currency: "AUD",
    value: valueDollars,
    transaction_id: transactionId ?? `sub_${Date.now()}`,
    items: [
      {
        item_id: planType,
        item_name: `${planType}_plan`,
        price: valueDollars,
      },
    ],
  });
}

export function trackPlanUpgradeClicked(fromPlan: string, toPlan: string): void {
  pushEvent(EventNames.PLAN_UPGRADE_CLICKED, {
    from_plan: fromPlan,
    to_plan: toPlan,
  });
}

export function trackPlanDowngradeClicked(fromPlan: string, toPlan: string): void {
  pushEvent(EventNames.PLAN_DOWNGRADE_CLICKED, {
    from_plan: fromPlan,
    to_plan: toPlan,
  });
}

// ─── Engagement ─────────────────────────────────────────────────────

export function trackAnalyticsExport(): void {
  pushEvent(EventNames.ANALYTICS_EXPORT);
}

export function trackDemoCallStarted(industry: string): void {
  pushEvent(EventNames.DEMO_CALL_STARTED, { industry });
}

export function trackDemoCallCompleted(
  industry: string,
  durationSeconds: number
): void {
  pushEvent(EventNames.DEMO_CALL_COMPLETED, {
    industry,
    duration_seconds: durationSeconds,
  });
}

export function trackROICalculatorUsed(
  missedCalls: number,
  calculatedLoss: number
): void {
  pushEvent(EventNames.ROI_CALCULATOR_USED, {
    missed_calls: missedCalls,
    calculated_loss: calculatedLoss,
  });
}

// ─── Marketing ──────────────────────────────────────────────────────

export function trackCTAClicked(ctaName: string, location: string): void {
  pushEvent(EventNames.CTA_CLICKED, { cta_name: ctaName, location });
}
