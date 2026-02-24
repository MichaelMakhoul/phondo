export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      api_keys: {
        Row: {
          created_at: string
          expires_at: string | null
          id: string
          is_active: boolean
          key_hash: string
          key_prefix: string
          last_used_at: string | null
          name: string
          organization_id: string
          scopes: string[]
        }
        Insert: {
          created_at?: string
          expires_at?: string | null
          id?: string
          is_active?: boolean
          key_hash: string
          key_prefix: string
          last_used_at?: string | null
          name: string
          organization_id: string
          scopes?: string[]
        }
        Update: {
          created_at?: string
          expires_at?: string | null
          id?: string
          is_active?: boolean
          key_hash?: string
          key_prefix?: string
          last_used_at?: string | null
          name?: string
          organization_id?: string
          scopes?: string[]
        }
        Relationships: [
          {
            foreignKeyName: "api_keys_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      appointments: {
        Row: {
          assistant_id: string | null
          attendee_email: string | null
          attendee_name: string
          attendee_phone: string | null
          call_id: string | null
          created_at: string | null
          duration_minutes: number | null
          end_time: string | null
          external_id: string | null
          id: string
          metadata: Json | null
          notes: string | null
          organization_id: string
          provider: string
          start_time: string
          status: string
          updated_at: string | null
        }
        Insert: {
          assistant_id?: string | null
          attendee_email?: string | null
          attendee_name: string
          attendee_phone?: string | null
          call_id?: string | null
          created_at?: string | null
          duration_minutes?: number | null
          end_time?: string | null
          external_id?: string | null
          id?: string
          metadata?: Json | null
          notes?: string | null
          organization_id: string
          provider?: string
          start_time: string
          status?: string
          updated_at?: string | null
        }
        Update: {
          assistant_id?: string | null
          attendee_email?: string | null
          attendee_name?: string
          attendee_phone?: string | null
          call_id?: string | null
          created_at?: string | null
          duration_minutes?: number | null
          end_time?: string | null
          external_id?: string | null
          id?: string
          metadata?: Json | null
          notes?: string | null
          organization_id?: string
          provider?: string
          start_time?: string
          status?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "appointments_assistant_id_fkey"
            columns: ["assistant_id"]
            isOneToOne: false
            referencedRelation: "assistants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointments_call_id_fkey"
            columns: ["call_id"]
            isOneToOne: false
            referencedRelation: "calls"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "appointments_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      assistant_templates: {
        Row: {
          created_at: string | null
          description: string | null
          first_message: string
          id: string
          industry: string
          is_featured: boolean | null
          name: string
          recommended_settings: Json | null
          sample_faqs: Json | null
          system_prompt: string
          voice_id: string | null
        }
        Insert: {
          created_at?: string | null
          description?: string | null
          first_message: string
          id?: string
          industry: string
          is_featured?: boolean | null
          name: string
          recommended_settings?: Json | null
          sample_faqs?: Json | null
          system_prompt: string
          voice_id?: string | null
        }
        Update: {
          created_at?: string | null
          description?: string | null
          first_message?: string
          id?: string
          industry?: string
          is_featured?: boolean | null
          name?: string
          recommended_settings?: Json | null
          sample_faqs?: Json | null
          system_prompt?: string
          voice_id?: string | null
        }
        Relationships: []
      }
      assistants: {
        Row: {
          created_at: string
          first_message: string
          id: string
          is_active: boolean
          knowledge_base: Json | null
          model: string
          model_provider: string
          name: string
          organization_id: string
          prompt_config: Json | null
          settings: Json | null
          system_prompt: string
          tools: Json | null
          updated_at: string
          vapi_assistant_id: string | null
          voice_id: string
          voice_provider: string
        }
        Insert: {
          created_at?: string
          first_message?: string
          id?: string
          is_active?: boolean
          knowledge_base?: Json | null
          model?: string
          model_provider?: string
          name: string
          organization_id: string
          prompt_config?: Json | null
          settings?: Json | null
          system_prompt: string
          tools?: Json | null
          updated_at?: string
          vapi_assistant_id?: string | null
          voice_id?: string
          voice_provider?: string
        }
        Update: {
          created_at?: string
          first_message?: string
          id?: string
          is_active?: boolean
          knowledge_base?: Json | null
          model?: string
          model_provider?: string
          name?: string
          organization_id?: string
          prompt_config?: Json | null
          settings?: Json | null
          system_prompt?: string
          tools?: Json | null
          updated_at?: string
          vapi_assistant_id?: string | null
          voice_id?: string
          voice_provider?: string
        }
        Relationships: [
          {
            foreignKeyName: "assistants_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      calendar_integrations: {
        Row: {
          access_token: string | null
          assistant_id: string | null
          booking_url: string | null
          calendar_id: string | null
          created_at: string | null
          id: string
          is_active: boolean | null
          organization_id: string
          provider: string
          refresh_token: string | null
          settings: Json | null
          token_expires_at: string | null
          updated_at: string | null
        }
        Insert: {
          access_token?: string | null
          assistant_id?: string | null
          booking_url?: string | null
          calendar_id?: string | null
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          organization_id: string
          provider: string
          refresh_token?: string | null
          settings?: Json | null
          token_expires_at?: string | null
          updated_at?: string | null
        }
        Update: {
          access_token?: string | null
          assistant_id?: string | null
          booking_url?: string | null
          calendar_id?: string | null
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          organization_id?: string
          provider?: string
          refresh_token?: string | null
          settings?: Json | null
          token_expires_at?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "calendar_integrations_assistant_id_fkey"
            columns: ["assistant_id"]
            isOneToOne: false
            referencedRelation: "assistants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "calendar_integrations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      caller_sms_log: {
        Row: {
          caller_phone: string
          created_at: string | null
          error_message: string | null
          from_number: string
          id: string
          message_body: string
          message_type: string
          organization_id: string
          status: string
          twilio_message_sid: string | null
        }
        Insert: {
          caller_phone: string
          created_at?: string | null
          error_message?: string | null
          from_number: string
          id?: string
          message_body: string
          message_type: string
          organization_id: string
          status?: string
          twilio_message_sid?: string | null
        }
        Update: {
          caller_phone?: string
          created_at?: string | null
          error_message?: string | null
          from_number?: string
          id?: string
          message_body?: string
          message_type?: string
          organization_id?: string
          status?: string
          twilio_message_sid?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "caller_sms_log_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      caller_sms_optouts: {
        Row: {
          id: string
          opted_out_at: string
          organization_id: string
          phone_number: string
          source: string
        }
        Insert: {
          id?: string
          opted_out_at?: string
          organization_id: string
          phone_number: string
          source?: string
        }
        Update: {
          id?: string
          opted_out_at?: string
          organization_id?: string
          phone_number?: string
          source?: string
        }
        Relationships: [
          {
            foreignKeyName: "caller_sms_optouts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      calls: {
        Row: {
          action_taken: string | null
          assistant_id: string | null
          caller_name: string | null
          caller_phone: string | null
          collected_data: Json | null
          cost_cents: number | null
          created_at: string
          direction: Database["public"]["Enums"]["call_direction"]
          duration_seconds: number | null
          ended_at: string | null
          follow_up_required: boolean | null
          id: string
          is_spam: boolean | null
          metadata: Json | null
          organization_id: string
          outcome: string | null
          phone_number_id: string | null
          recording_url: string | null
          sentiment: string | null
          spam_score: number | null
          started_at: string | null
          status: Database["public"]["Enums"]["call_status"]
          summary: string | null
          transcript: string | null
          vapi_call_id: string
        }
        Insert: {
          action_taken?: string | null
          assistant_id?: string | null
          caller_name?: string | null
          caller_phone?: string | null
          collected_data?: Json | null
          cost_cents?: number | null
          created_at?: string
          direction?: Database["public"]["Enums"]["call_direction"]
          duration_seconds?: number | null
          ended_at?: string | null
          follow_up_required?: boolean | null
          id?: string
          is_spam?: boolean | null
          metadata?: Json | null
          organization_id: string
          outcome?: string | null
          phone_number_id?: string | null
          recording_url?: string | null
          sentiment?: string | null
          spam_score?: number | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["call_status"]
          summary?: string | null
          transcript?: string | null
          vapi_call_id: string
        }
        Update: {
          action_taken?: string | null
          assistant_id?: string | null
          caller_name?: string | null
          caller_phone?: string | null
          collected_data?: Json | null
          cost_cents?: number | null
          created_at?: string
          direction?: Database["public"]["Enums"]["call_direction"]
          duration_seconds?: number | null
          ended_at?: string | null
          follow_up_required?: boolean | null
          id?: string
          is_spam?: boolean | null
          metadata?: Json | null
          organization_id?: string
          outcome?: string | null
          phone_number_id?: string | null
          recording_url?: string | null
          sentiment?: string | null
          spam_score?: number | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["call_status"]
          summary?: string | null
          transcript?: string | null
          vapi_call_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "calls_assistant_id_fkey"
            columns: ["assistant_id"]
            isOneToOne: false
            referencedRelation: "assistants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "calls_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "calls_phone_number_id_fkey"
            columns: ["phone_number_id"]
            isOneToOne: false
            referencedRelation: "phone_numbers"
            referencedColumns: ["id"]
          },
        ]
      }
      integration_logs: {
        Row: {
          attempted_at: string | null
          event_type: string
          id: string
          integration_id: string
          payload: Json
          response_body: string | null
          response_status: number | null
          retry_count: number | null
          success: boolean
        }
        Insert: {
          attempted_at?: string | null
          event_type: string
          id?: string
          integration_id: string
          payload: Json
          response_body?: string | null
          response_status?: number | null
          retry_count?: number | null
          success?: boolean
        }
        Update: {
          attempted_at?: string | null
          event_type?: string
          id?: string
          integration_id?: string
          payload?: Json
          response_body?: string | null
          response_status?: number | null
          retry_count?: number | null
          success?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "integration_logs_integration_id_fkey"
            columns: ["integration_id"]
            isOneToOne: false
            referencedRelation: "integrations"
            referencedColumns: ["id"]
          },
        ]
      }
      integrations: {
        Row: {
          created_at: string | null
          events: string[]
          id: string
          is_active: boolean
          metadata: Json | null
          name: string
          organization_id: string
          platform: string
          signing_secret: string
          updated_at: string | null
          webhook_url: string
        }
        Insert: {
          created_at?: string | null
          events?: string[]
          id?: string
          is_active?: boolean
          metadata?: Json | null
          name: string
          organization_id: string
          platform?: string
          signing_secret: string
          updated_at?: string | null
          webhook_url: string
        }
        Update: {
          created_at?: string | null
          events?: string[]
          id?: string
          is_active?: boolean
          metadata?: Json | null
          name?: string
          organization_id?: string
          platform?: string
          signing_secret?: string
          updated_at?: string | null
          webhook_url?: string
        }
        Relationships: [
          {
            foreignKeyName: "integrations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      knowledge_bases: {
        Row: {
          assistant_id: string | null
          content: string
          created_at: string | null
          id: string
          is_active: boolean | null
          metadata: Json | null
          organization_id: string
          source_type: string
          source_url: string | null
          title: string | null
          updated_at: string | null
        }
        Insert: {
          assistant_id?: string | null
          content: string
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          metadata?: Json | null
          organization_id: string
          source_type: string
          source_url?: string | null
          title?: string | null
          updated_at?: string | null
        }
        Update: {
          assistant_id?: string | null
          content?: string
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          metadata?: Json | null
          organization_id?: string
          source_type?: string
          source_url?: string | null
          title?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "knowledge_bases_assistant_id_fkey"
            columns: ["assistant_id"]
            isOneToOne: false
            referencedRelation: "assistants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "knowledge_bases_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_preferences: {
        Row: {
          created_at: string | null
          email_daily_summary: boolean | null
          email_on_appointment_booked: boolean | null
          email_on_failed_call: boolean
          email_on_missed_call: boolean | null
          email_on_voicemail: boolean | null
          id: string
          organization_id: string
          sms_appointment_confirmation: boolean | null
          sms_on_failed_call: boolean
          sms_on_missed_call: boolean | null
          sms_on_voicemail: boolean | null
          sms_phone_number: string | null
          sms_textback_on_missed_call: boolean | null
          updated_at: string | null
          user_id: string | null
          webhook_url: string | null
        }
        Insert: {
          created_at?: string | null
          email_daily_summary?: boolean | null
          email_on_appointment_booked?: boolean | null
          email_on_failed_call?: boolean
          email_on_missed_call?: boolean | null
          email_on_voicemail?: boolean | null
          id?: string
          organization_id: string
          sms_appointment_confirmation?: boolean | null
          sms_on_failed_call?: boolean
          sms_on_missed_call?: boolean | null
          sms_on_voicemail?: boolean | null
          sms_phone_number?: string | null
          sms_textback_on_missed_call?: boolean | null
          updated_at?: string | null
          user_id?: string | null
          webhook_url?: string | null
        }
        Update: {
          created_at?: string | null
          email_daily_summary?: boolean | null
          email_on_appointment_booked?: boolean | null
          email_on_failed_call?: boolean
          email_on_missed_call?: boolean | null
          email_on_voicemail?: boolean | null
          id?: string
          organization_id?: string
          sms_appointment_confirmation?: boolean | null
          sms_on_failed_call?: boolean
          sms_on_missed_call?: boolean | null
          sms_on_voicemail?: boolean | null
          sms_phone_number?: string | null
          sms_textback_on_missed_call?: boolean | null
          updated_at?: string | null
          user_id?: string | null
          webhook_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "notification_preferences_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      org_members: {
        Row: {
          created_at: string
          id: string
          organization_id: string
          role: Database["public"]["Enums"]["member_role"]
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          organization_id: string
          role?: Database["public"]["Enums"]["member_role"]
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          organization_id?: string
          role?: Database["public"]["Enums"]["member_role"]
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "org_members_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          business_address: string | null
          business_hours: Json | null
          business_name: string | null
          business_phone: string | null
          business_website: string | null
          country: string
          created_at: string
          default_appointment_duration: number
          id: string
          industry: string | null
          logo_url: string | null
          name: string
          parent_org_id: string | null
          primary_color: string | null
          slug: string
          stripe_customer_id: string | null
          timezone: string | null
          type: Database["public"]["Enums"]["organization_type"]
          updated_at: string
        }
        Insert: {
          business_address?: string | null
          business_hours?: Json | null
          business_name?: string | null
          business_phone?: string | null
          business_website?: string | null
          country?: string
          created_at?: string
          default_appointment_duration?: number
          id?: string
          industry?: string | null
          logo_url?: string | null
          name: string
          parent_org_id?: string | null
          primary_color?: string | null
          slug: string
          stripe_customer_id?: string | null
          timezone?: string | null
          type?: Database["public"]["Enums"]["organization_type"]
          updated_at?: string
        }
        Update: {
          business_address?: string | null
          business_hours?: Json | null
          business_name?: string | null
          business_phone?: string | null
          business_website?: string | null
          country?: string
          created_at?: string
          default_appointment_duration?: number
          id?: string
          industry?: string | null
          logo_url?: string | null
          name?: string
          parent_org_id?: string | null
          primary_color?: string | null
          slug?: string
          stripe_customer_id?: string | null
          timezone?: string | null
          type?: Database["public"]["Enums"]["organization_type"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "organizations_parent_org_id_fkey"
            columns: ["parent_org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      phone_numbers: {
        Row: {
          assistant_id: string | null
          carrier: string | null
          created_at: string
          forwarding_status: string | null
          friendly_name: string | null
          id: string
          is_active: boolean
          organization_id: string
          phone_number: string
          source_type: string
          twilio_sid: string | null
          updated_at: string
          user_phone_number: string | null
          vapi_phone_number_id: string | null
          voice_provider: string
        }
        Insert: {
          assistant_id?: string | null
          carrier?: string | null
          created_at?: string
          forwarding_status?: string | null
          friendly_name?: string | null
          id?: string
          is_active?: boolean
          organization_id: string
          phone_number: string
          source_type?: string
          twilio_sid?: string | null
          updated_at?: string
          user_phone_number?: string | null
          vapi_phone_number_id?: string | null
          voice_provider?: string
        }
        Update: {
          assistant_id?: string | null
          carrier?: string | null
          created_at?: string
          forwarding_status?: string | null
          friendly_name?: string | null
          id?: string
          is_active?: boolean
          organization_id?: string
          phone_number?: string
          source_type?: string
          twilio_sid?: string | null
          updated_at?: string
          user_phone_number?: string | null
          vapi_phone_number_id?: string | null
          voice_provider?: string
        }
        Relationships: [
          {
            foreignKeyName: "phone_numbers_assistant_id_fkey"
            columns: ["assistant_id"]
            isOneToOne: false
            referencedRelation: "assistants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "phone_numbers_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      subscriptions: {
        Row: {
          assistants_limit: number | null
          calls_limit: number | null
          calls_used: number | null
          cancel_at_period_end: boolean
          created_at: string
          current_period_end: string
          current_period_start: string
          id: string
          included_minutes: number
          organization_id: string
          phone_numbers_limit: number | null
          plan_type: Database["public"]["Enums"]["plan_type"]
          status: Database["public"]["Enums"]["subscription_status"]
          stripe_price_id: string
          stripe_subscription_id: string
          trial_end: string | null
          updated_at: string
        }
        Insert: {
          assistants_limit?: number | null
          calls_limit?: number | null
          calls_used?: number | null
          cancel_at_period_end?: boolean
          created_at?: string
          current_period_end: string
          current_period_start: string
          id?: string
          included_minutes?: number
          organization_id: string
          phone_numbers_limit?: number | null
          plan_type?: Database["public"]["Enums"]["plan_type"]
          status?: Database["public"]["Enums"]["subscription_status"]
          stripe_price_id: string
          stripe_subscription_id: string
          trial_end?: string | null
          updated_at?: string
        }
        Update: {
          assistants_limit?: number | null
          calls_limit?: number | null
          calls_used?: number | null
          cancel_at_period_end?: boolean
          created_at?: string
          current_period_end?: string
          current_period_start?: string
          id?: string
          included_minutes?: number
          organization_id?: string
          phone_numbers_limit?: number | null
          plan_type?: Database["public"]["Enums"]["plan_type"]
          status?: Database["public"]["Enums"]["subscription_status"]
          stripe_price_id?: string
          stripe_subscription_id?: string
          trial_end?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "subscriptions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: true
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      transfer_rules: {
        Row: {
          announcement_message: string | null
          assistant_id: string
          created_at: string | null
          id: string
          is_active: boolean | null
          name: string
          organization_id: string
          priority: number | null
          transfer_to_name: string | null
          transfer_to_phone: string
          trigger_intent: string | null
          trigger_keywords: string[] | null
        }
        Insert: {
          announcement_message?: string | null
          assistant_id: string
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          name: string
          organization_id: string
          priority?: number | null
          transfer_to_name?: string | null
          transfer_to_phone: string
          trigger_intent?: string | null
          trigger_keywords?: string[] | null
        }
        Update: {
          announcement_message?: string | null
          assistant_id?: string
          created_at?: string | null
          id?: string
          is_active?: boolean | null
          name?: string
          organization_id?: string
          priority?: number | null
          transfer_to_name?: string | null
          transfer_to_phone?: string
          trigger_intent?: string | null
          trigger_keywords?: string[] | null
        }
        Relationships: [
          {
            foreignKeyName: "transfer_rules_assistant_id_fkey"
            columns: ["assistant_id"]
            isOneToOne: false
            referencedRelation: "assistants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transfer_rules_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      usage_records: {
        Row: {
          call_id: string | null
          cost_cents: number
          created_at: string
          id: string
          minutes_used: number
          organization_id: string
          period_end: string
          period_start: string
          record_type: string | null
          reported_to_stripe: boolean
          stripe_usage_record_id: string | null
        }
        Insert: {
          call_id?: string | null
          cost_cents?: number
          created_at?: string
          id?: string
          minutes_used: number
          organization_id: string
          period_end: string
          period_start: string
          record_type?: string | null
          reported_to_stripe?: boolean
          stripe_usage_record_id?: string | null
        }
        Update: {
          call_id?: string | null
          cost_cents?: number
          created_at?: string
          id?: string
          minutes_used?: number
          organization_id?: string
          period_end?: string
          period_start?: string
          record_type?: string | null
          reported_to_stripe?: boolean
          stripe_usage_record_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "usage_records_call_id_fkey"
            columns: ["call_id"]
            isOneToOne: false
            referencedRelation: "calls"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "usage_records_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      user_profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          email: string
          full_name: string | null
          id: string
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          email: string
          full_name?: string | null
          id: string
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          email?: string
          full_name?: string | null
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      create_organization_with_owner: {
        Args: {
          org_name: string
          org_slug: string
          org_type?: Database["public"]["Enums"]["organization_type"]
        }
        Returns: {
          id: string
          name: string
          slug: string
          type: Database["public"]["Enums"]["organization_type"]
        }[]
      }
      get_user_organizations: { Args: { user_uuid: string }; Returns: string[] }
      increment_call_usage: {
        Args: { org_id: string }
        Returns: {
          calls_limit: number
          calls_used: number
        }[]
      }
      is_org_admin: {
        Args: { org_id: string; user_uuid: string }
        Returns: boolean
      }
      is_org_member: {
        Args: { org_id: string; user_uuid: string }
        Returns: boolean
      }
    }
    Enums: {
      call_direction: "inbound" | "outbound"
      call_status:
        | "queued"
        | "ringing"
        | "in-progress"
        | "completed"
        | "failed"
        | "no-answer"
        | "busy"
      industry_type:
        | "dental"
        | "legal"
        | "home_services"
        | "medical"
        | "real_estate"
        | "other"
      member_role: "owner" | "admin" | "member"
      organization_type: "business" | "agency"
      plan_type:
        | "starter"
        | "professional"
        | "business"
        | "agency_starter"
        | "agency_growth"
        | "agency_scale"
      subscription_status:
        | "active"
        | "canceled"
        | "incomplete"
        | "incomplete_expired"
        | "past_due"
        | "trialing"
        | "unpaid"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      call_direction: ["inbound", "outbound"],
      call_status: [
        "queued",
        "ringing",
        "in-progress",
        "completed",
        "failed",
        "no-answer",
        "busy",
      ],
      industry_type: [
        "dental",
        "legal",
        "home_services",
        "medical",
        "real_estate",
        "other",
      ],
      member_role: ["owner", "admin", "member"],
      organization_type: ["business", "agency"],
      plan_type: [
        "starter",
        "professional",
        "business",
        "agency_starter",
        "agency_growth",
        "agency_scale",
      ],
      subscription_status: [
        "active",
        "canceled",
        "incomplete",
        "incomplete_expired",
        "past_due",
        "trialing",
        "unpaid",
      ],
    },
  },
} as const
