export interface PhoneNumber {
  id: string;
  phone_number: string;
  friendly_name: string | null;
  is_active: boolean;
  ai_enabled: boolean;
  source_type: "purchased" | "forwarded";
  user_phone_number: string | null;
  forwarding_status: "pending_setup" | "active" | "paused" | null;
  carrier: string | null;
  assistants: { id: string; name: string } | null;
}

export interface Assistant {
  id: string;
  name: string;
}
