export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export interface Database {
  graphql_public: {
    Tables: Record<string, never>;
    Views: Record<string, never>;
    Functions: {
      graphql: {
        Args: {
          operationName?: string;
          query?: string;
          variables?: Json;
          extensions?: Json;
        };
        Returns: Json;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
  public: {
    Tables: {
      organizations: {
        Row: {
          id: string;
          name: string;
          slug: string;
          type: "business" | "agency";
          logo_url: string | null;
          primary_color: string | null;
          parent_org_id: string | null;
          stripe_customer_id: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          slug: string;
          type?: "business" | "agency";
          logo_url?: string | null;
          primary_color?: string | null;
          parent_org_id?: string | null;
          stripe_customer_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          slug?: string;
          type?: "business" | "agency";
          logo_url?: string | null;
          primary_color?: string | null;
          parent_org_id?: string | null;
          stripe_customer_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "organizations_parent_org_id_fkey";
            columns: ["parent_org_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          }
        ];
      };
      org_members: {
        Row: {
          id: string;
          organization_id: string;
          user_id: string;
          role: "owner" | "admin" | "member";
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          user_id: string;
          role?: "owner" | "admin" | "member";
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          user_id?: string;
          role?: "owner" | "admin" | "member";
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "org_members_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          }
        ];
      };
      assistants: {
        Row: {
          id: string;
          organization_id: string;
          name: string;
          vapi_assistant_id: string | null;
          system_prompt: string;
          first_message: string;
          voice_id: string;
          voice_provider: string;
          model: string;
          model_provider: string;
          knowledge_base: Json | null;
          tools: Json | null;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          name: string;
          vapi_assistant_id?: string | null;
          system_prompt: string;
          first_message: string;
          voice_id?: string;
          voice_provider?: string;
          model?: string;
          model_provider?: string;
          knowledge_base?: Json | null;
          tools?: Json | null;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          name?: string;
          vapi_assistant_id?: string | null;
          system_prompt?: string;
          first_message?: string;
          voice_id?: string;
          voice_provider?: string;
          model?: string;
          model_provider?: string;
          knowledge_base?: Json | null;
          tools?: Json | null;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "assistants_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          }
        ];
      };
      phone_numbers: {
        Row: {
          id: string;
          organization_id: string;
          assistant_id: string | null;
          phone_number: string;
          vapi_phone_number_id: string | null;
          twilio_sid: string | null;
          friendly_name: string | null;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          assistant_id?: string | null;
          phone_number: string;
          vapi_phone_number_id?: string | null;
          twilio_sid?: string | null;
          friendly_name?: string | null;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          assistant_id?: string | null;
          phone_number?: string;
          vapi_phone_number_id?: string | null;
          twilio_sid?: string | null;
          friendly_name?: string | null;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "phone_numbers_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "phone_numbers_assistant_id_fkey";
            columns: ["assistant_id"];
            isOneToOne: false;
            referencedRelation: "assistants";
            referencedColumns: ["id"];
          }
        ];
      };
      calls: {
        Row: {
          id: string;
          organization_id: string;
          assistant_id: string | null;
          phone_number_id: string | null;
          vapi_call_id: string;
          caller_phone: string | null;
          direction: "inbound" | "outbound";
          status: "queued" | "ringing" | "in-progress" | "completed" | "failed" | "no-answer" | "busy";
          started_at: string | null;
          ended_at: string | null;
          duration_seconds: number | null;
          transcript: string | null;
          recording_url: string | null;
          summary: string | null;
          sentiment: string | null;
          metadata: Json | null;
          cost_cents: number | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          assistant_id?: string | null;
          phone_number_id?: string | null;
          vapi_call_id: string;
          caller_phone?: string | null;
          direction?: "inbound" | "outbound";
          status?: "queued" | "ringing" | "in-progress" | "completed" | "failed" | "no-answer" | "busy";
          started_at?: string | null;
          ended_at?: string | null;
          duration_seconds?: number | null;
          transcript?: string | null;
          recording_url?: string | null;
          summary?: string | null;
          sentiment?: string | null;
          metadata?: Json | null;
          cost_cents?: number | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          assistant_id?: string | null;
          phone_number_id?: string | null;
          vapi_call_id?: string;
          caller_phone?: string | null;
          direction?: "inbound" | "outbound";
          status?: "queued" | "ringing" | "in-progress" | "completed" | "failed" | "no-answer" | "busy";
          started_at?: string | null;
          ended_at?: string | null;
          duration_seconds?: number | null;
          transcript?: string | null;
          recording_url?: string | null;
          summary?: string | null;
          sentiment?: string | null;
          metadata?: Json | null;
          cost_cents?: number | null;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "calls_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "calls_assistant_id_fkey";
            columns: ["assistant_id"];
            isOneToOne: false;
            referencedRelation: "assistants";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "calls_phone_number_id_fkey";
            columns: ["phone_number_id"];
            isOneToOne: false;
            referencedRelation: "phone_numbers";
            referencedColumns: ["id"];
          }
        ];
      };
      subscriptions: {
        Row: {
          id: string;
          organization_id: string;
          stripe_subscription_id: string;
          stripe_price_id: string;
          plan_type: "starter" | "professional" | "business" | "agency_starter" | "agency_growth" | "agency_scale";
          status: "active" | "canceled" | "incomplete" | "incomplete_expired" | "past_due" | "trialing" | "unpaid";
          included_minutes: number;
          current_period_start: string;
          current_period_end: string;
          cancel_at_period_end: boolean;
          calls_limit: number | null;
          calls_used: number | null;
          assistants_limit: number | null;
          phone_numbers_limit: number | null;
          trial_end: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          stripe_subscription_id: string;
          stripe_price_id: string;
          plan_type?: "starter" | "professional" | "business" | "agency_starter" | "agency_growth" | "agency_scale";
          status?: "active" | "canceled" | "incomplete" | "incomplete_expired" | "past_due" | "trialing" | "unpaid";
          included_minutes?: number;
          current_period_start: string;
          current_period_end: string;
          cancel_at_period_end?: boolean;
          calls_limit?: number | null;
          calls_used?: number | null;
          assistants_limit?: number | null;
          phone_numbers_limit?: number | null;
          trial_end?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          stripe_subscription_id?: string;
          stripe_price_id?: string;
          plan_type?: "starter" | "professional" | "business" | "agency_starter" | "agency_growth" | "agency_scale";
          status?: "active" | "canceled" | "incomplete" | "incomplete_expired" | "past_due" | "trialing" | "unpaid";
          included_minutes?: number;
          current_period_start?: string;
          current_period_end?: string;
          cancel_at_period_end?: boolean;
          calls_limit?: number | null;
          calls_used?: number | null;
          assistants_limit?: number | null;
          phone_numbers_limit?: number | null;
          trial_end?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "subscriptions_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: true;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          }
        ];
      };
      usage_records: {
        Row: {
          id: string;
          organization_id: string;
          call_id: string | null;
          period_start: string;
          period_end: string;
          minutes_used: number;
          cost_cents: number;
          reported_to_stripe: boolean;
          stripe_usage_record_id: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          call_id?: string | null;
          period_start: string;
          period_end: string;
          minutes_used: number;
          cost_cents?: number;
          reported_to_stripe?: boolean;
          stripe_usage_record_id?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          call_id?: string | null;
          period_start?: string;
          period_end?: string;
          minutes_used?: number;
          cost_cents?: number;
          reported_to_stripe?: boolean;
          stripe_usage_record_id?: string | null;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "usage_records_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "usage_records_call_id_fkey";
            columns: ["call_id"];
            isOneToOne: false;
            referencedRelation: "calls";
            referencedColumns: ["id"];
          }
        ];
      };
      api_keys: {
        Row: {
          id: string;
          organization_id: string;
          name: string;
          key_hash: string;
          key_prefix: string;
          scopes: string[];
          last_used_at: string | null;
          expires_at: string | null;
          is_active: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          name: string;
          key_hash: string;
          key_prefix: string;
          scopes?: string[];
          last_used_at?: string | null;
          expires_at?: string | null;
          is_active?: boolean;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          name?: string;
          key_hash?: string;
          key_prefix?: string;
          scopes?: string[];
          last_used_at?: string | null;
          expires_at?: string | null;
          is_active?: boolean;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "api_keys_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          }
        ];
      };
      user_profiles: {
        Row: {
          id: string;
          email: string;
          full_name: string | null;
          avatar_url: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          email: string;
          full_name?: string | null;
          avatar_url?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          email?: string;
          full_name?: string | null;
          avatar_url?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      [_ in never]: never;
    };
    Enums: {
      organization_type: "business" | "agency";
      member_role: "owner" | "admin" | "member";
      call_direction: "inbound" | "outbound";
      call_status: "queued" | "ringing" | "in-progress" | "completed" | "failed" | "no-answer" | "busy";
      plan_type: "starter" | "professional" | "business" | "agency_starter" | "agency_growth" | "agency_scale";
      subscription_status: "active" | "canceled" | "incomplete" | "incomplete_expired" | "past_due" | "trialing" | "unpaid";
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

export type Tables<
  PublicTableNameOrOptions extends
    | keyof (Database["public"]["Tables"] & Database["public"]["Views"])
    | { schema: keyof Database },
  TableName extends PublicTableNameOrOptions extends { schema: keyof Database }
    ? keyof (Database[PublicTableNameOrOptions["schema"]]["Tables"] &
        Database[PublicTableNameOrOptions["schema"]]["Views"])
    : never = never
> = PublicTableNameOrOptions extends { schema: keyof Database }
  ? (Database[PublicTableNameOrOptions["schema"]]["Tables"] &
      Database[PublicTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : PublicTableNameOrOptions extends keyof (Database["public"]["Tables"] &
      Database["public"]["Views"])
  ? (Database["public"]["Tables"] &
      Database["public"]["Views"])[PublicTableNameOrOptions] extends {
      Row: infer R;
    }
    ? R
    : never
  : never;

export type TablesInsert<
  PublicTableNameOrOptions extends
    | keyof Database["public"]["Tables"]
    | { schema: keyof Database },
  TableName extends PublicTableNameOrOptions extends { schema: keyof Database }
    ? keyof Database[PublicTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = PublicTableNameOrOptions extends { schema: keyof Database }
  ? Database[PublicTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : PublicTableNameOrOptions extends keyof Database["public"]["Tables"]
  ? Database["public"]["Tables"][PublicTableNameOrOptions] extends {
      Insert: infer I;
    }
    ? I
    : never
  : never;

export type TablesUpdate<
  PublicTableNameOrOptions extends
    | keyof Database["public"]["Tables"]
    | { schema: keyof Database },
  TableName extends PublicTableNameOrOptions extends { schema: keyof Database }
    ? keyof Database[PublicTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = PublicTableNameOrOptions extends { schema: keyof Database }
  ? Database[PublicTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : PublicTableNameOrOptions extends keyof Database["public"]["Tables"]
  ? Database["public"]["Tables"][PublicTableNameOrOptions] extends {
      Update: infer U;
    }
    ? U
    : never
  : never;

export type Enums<
  PublicEnumNameOrOptions extends
    | keyof Database["public"]["Enums"]
    | { schema: keyof Database },
  EnumName extends PublicEnumNameOrOptions extends { schema: keyof Database }
    ? keyof Database[PublicEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = PublicEnumNameOrOptions extends { schema: keyof Database }
  ? Database[PublicEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : PublicEnumNameOrOptions extends keyof Database["public"]["Enums"]
  ? Database["public"]["Enums"][PublicEnumNameOrOptions]
  : never;
