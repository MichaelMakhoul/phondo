"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Plus, PhoneForwarded, Phone, ChevronDown } from "lucide-react";
import { BuyPhoneNumberDialog } from "./buy-dialog";
import { ForwardingSetupDialog } from "./forwarding-setup-dialog";

interface Assistant {
  id: string;
  name: string;
}

interface PhoneNumberActionsProps {
  assistants: Assistant[];
  countryCode?: string;
  disabled?: boolean;
}

export function PhoneNumberActions({ assistants, countryCode = "US", disabled = false }: PhoneNumberActionsProps) {
  const [buyOpen, setBuyOpen] = useState(false);
  const [forwardOpen, setForwardOpen] = useState(false);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button disabled={disabled}>
            <Plus className="mr-2 h-4 w-4" />
            Add Number
            <ChevronDown className="ml-2 h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => setForwardOpen(true)}>
            <PhoneForwarded className="mr-2 h-4 w-4" />
            Use My Existing Number
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setBuyOpen(true)}>
            <Phone className="mr-2 h-4 w-4" />
            Buy a New Number
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <BuyPhoneNumberDialog
        assistants={assistants}
        countryCode={countryCode}
        open={buyOpen}
        onOpenChange={setBuyOpen}
      />
      <ForwardingSetupDialog
        assistants={assistants}
        countryCode={countryCode}
        open={forwardOpen}
        onOpenChange={setForwardOpen}
      />
    </>
  );
}
