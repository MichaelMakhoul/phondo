import Link from "next/link";
import { Phone } from "lucide-react";

export function MarketingFooter() {
  return (
    <footer className="border-t py-12">
      <div className="container mx-auto px-4">
        <div className="grid gap-8 sm:grid-cols-2 md:grid-cols-4">
          <div>
            <Link href="/" className="flex items-center gap-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-md bg-orange-500">
                <Phone className="h-3.5 w-3.5 text-white" />
              </div>
              <span className="font-semibold">Hola Recep</span>
            </Link>
            <p className="mt-2 text-sm text-muted-foreground">
              AI phone receptionist for Australian businesses.
            </p>
          </div>
          <div>
            <h4 className="text-sm font-semibold">Product</h4>
            <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
              <li>
                <Link href="/pricing" className="hover:text-foreground">
                  Pricing
                </Link>
              </li>
              <li>
                <Link href="/#calculator" className="hover:text-foreground">
                  ROI Calculator
                </Link>
              </li>
              <li>
                <Link href="/demo" className="hover:text-foreground">
                  Live Demo
                </Link>
              </li>
            </ul>
          </div>
          <div>
            <h4 className="text-sm font-semibold">Legal</h4>
            <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
              <li>
                <Link href="/privacy" className="hover:text-foreground">
                  Privacy Policy
                </Link>
              </li>
              <li>
                <Link href="/terms" className="hover:text-foreground">
                  Terms of Service
                </Link>
              </li>
              <li>
                <Link href="/data-sovereignty" className="hover:text-foreground">
                  Data Sovereignty
                </Link>
              </li>
            </ul>
          </div>
          <div>
            <h4 className="text-sm font-semibold">Contact</h4>
            <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
              <li>support@holarecep.com</li>
              <li>Sydney, Australia</li>
            </ul>
          </div>
        </div>
        <div className="mt-8 border-t pt-8 text-center text-sm text-muted-foreground">
          &copy; {new Date().getFullYear()} Hola Recep. All rights reserved.
        </div>
      </div>
    </footer>
  );
}
