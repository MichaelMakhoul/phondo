"use client";

import { useState, useCallback } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Search,
  Download,
  Loader2,
  Globe,
  Phone,
  Star,
  ScanSearch,
  Building2,
  ExternalLink,
  AlertCircle,
} from "lucide-react";

// ── Constants ────────────────────────────────────────────────────────

const PROFESSIONS = [
  { value: "dentist", label: "Dental" },
  { value: "physiotherapist", label: "Physiotherapy" },
  { value: "chiropractor", label: "Chiropractic" },
  { value: "psychologist", label: "Psychology" },
  { value: "podiatrist", label: "Podiatry" },
  { value: "optometrist", label: "Optometry" },
  { value: "veterinarian", label: "Veterinary" },
  { value: "massage therapist", label: "Massage / Myotherapy" },
  { value: "GP medical clinic", label: "GP / Medical" },
  { value: "plumber", label: "Plumber" },
  { value: "electrician", label: "Electrician" },
  { value: "HVAC air conditioning", label: "HVAC" },
  { value: "locksmith", label: "Locksmith" },
  { value: "pest control", label: "Pest Control" },
  { value: "cleaning service", label: "Cleaning" },
  { value: "landscaper gardener", label: "Landscaping" },
  { value: "law firm lawyer", label: "Legal" },
  { value: "conveyancer", label: "Conveyancing" },
  { value: "real estate agent", label: "Real Estate" },
  { value: "property manager", label: "Property Management" },
  { value: "beauty salon", label: "Beauty / Salon" },
  { value: "accounting firm", label: "Accounting" },
] as const;

const RESULT_LIMITS = [10, 25, 50, 100] as const;

// ── Types ────────────────────────────────────────────────────────────

interface Business {
  id: string;
  google_place_id: string;
  name: string;
  address: string | null;
  phone: string | null;
  website: string | null;
  google_rating: number | null;
  google_review_count: number | null;
  profession: string | null;
  detected_crm: string | null;
  detected_crm_details: { software: string | null; confidence: string; signals: string[] } | null;
  website_scanned_at: string | null;
  website_scan_error: string | null;
}

type CrmFilter = "all" | "none" | "no_website" | "has_crm";

// ── Component ────────────────────────────────────────────────────────

export function LeadDiscoveryPanel() {
  // Search state
  const [location, setLocation] = useState("");
  const [selectedProfessions, setSelectedProfessions] = useState<string[]>([]);
  const [limit, setLimit] = useState<number>(25);

  // Results state
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [searching, setSearching] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cached, setCached] = useState(false);

  // Filter state
  const [crmFilter, setCrmFilter] = useState<CrmFilter | string>("all");
  const [sortField, setSortField] = useState<"name" | "google_rating" | "detected_crm">("name");
  const [sortAsc, setSortAsc] = useState(true);

  // ── Search ───────────────────────────────────────────────────────

  const handleSearch = useCallback(async () => {
    if (!location.trim() || selectedProfessions.length === 0) return;

    setSearching(true);
    setError(null);
    setBusinesses([]);

    try {
      const res = await fetch("/api/admin/lead-discovery/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          location: location.trim(),
          professions: selectedProfessions,
          limit,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Search failed" }));
        setError(data.error || `HTTP ${res.status}`);
        return;
      }

      const data = await res.json();
      setBusinesses(data.businesses ?? []);
      setCached(data.cached ?? false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setSearching(false);
    }
  }, [location, selectedProfessions, limit]);

  // ── CRM Scan ─────────────────────────────────────────────────────

  const handleScan = useCallback(async () => {
    const unscanned = businesses.filter((b) => b.detected_crm === null);
    if (unscanned.length === 0) return;

    setScanning(true);
    try {
      const res = await fetch("/api/admin/lead-discovery/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessIds: unscanned.map((b) => b.id) }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Scan failed" }));
        setError(data.error || `Scan failed (HTTP ${res.status})`);
        return;
      }

      const data = await res.json();
      const updated = data.businesses as Business[];

      // Merge scan results into existing businesses
      setBusinesses((prev) =>
        prev.map((b) => {
          const match = updated.find((u) => u.id === b.id);
          return match ?? b;
        })
      );
    } finally {
      setScanning(false);
    }
  }, [businesses]);

  // ── Export ────────────────────────────────────────────────────────

  const handleExport = useCallback(() => {
    const params = new URLSearchParams();
    if (location) params.set("location", location);
    if (selectedProfessions.length) params.set("professions", selectedProfessions.join(","));
    if (crmFilter !== "all") params.set("crmFilter", crmFilter);

    window.open(`/api/admin/lead-discovery/export?${params}`, "_blank");
  }, [location, selectedProfessions, crmFilter]);

  // ── Profession toggle ────────────────────────────────────────────

  const toggleProfession = (value: string) => {
    setSelectedProfessions((prev) =>
      prev.includes(value) ? prev.filter((p) => p !== value) : [...prev, value]
    );
  };

  // ── Filter + Sort ────────────────────────────────────────────────

  const filteredBusinesses = businesses.filter((b) => {
    if (crmFilter === "all") return true;
    if (crmFilter === "none") return b.detected_crm === "none";
    if (crmFilter === "no_website") return b.detected_crm === "no_website";
    if (crmFilter === "has_crm")
      return b.detected_crm && b.detected_crm !== "none" && b.detected_crm !== "no_website";
    return b.detected_crm === crmFilter;
  });

  const sortedBusinesses = [...filteredBusinesses].sort((a, b) => {
    const dir = sortAsc ? 1 : -1;
    if (sortField === "name") return (a.name ?? "").localeCompare(b.name ?? "") * dir;
    if (sortField === "google_rating") return ((a.google_rating ?? 0) - (b.google_rating ?? 0)) * dir;
    if (sortField === "detected_crm") return (a.detected_crm ?? "").localeCompare(b.detected_crm ?? "") * dir;
    return 0;
  });

  const handleSort = (field: typeof sortField) => {
    if (sortField === field) {
      setSortAsc(!sortAsc);
    } else {
      setSortField(field);
      setSortAsc(true);
    }
  };

  // ── Stats ────────────────────────────────────────────────────────

  const stats = {
    total: businesses.length,
    scanned: businesses.filter((b) => b.detected_crm !== null).length,
    hasCrm: businesses.filter(
      (b) => b.detected_crm && b.detected_crm !== "none" && b.detected_crm !== "no_website"
    ).length,
    noCrm: businesses.filter((b) => b.detected_crm === "none").length,
    noWebsite: businesses.filter((b) => b.detected_crm === "no_website").length,
  };

  // Unique CRM names in results (for filter dropdown)
  const uniqueCrms = [
    ...new Set(
      businesses
        .map((b) => b.detected_crm)
        .filter((c): c is string => !!c && c !== "none" && c !== "no_website")
    ),
  ].sort();

  return (
    <div className="space-y-6">
      {/* ── Search Form ─────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Search Businesses</CardTitle>
          <CardDescription>
            Find businesses by location and profession. Results are cached for 7
            days.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Location */}
          <div>
            <label className="text-sm font-medium mb-1.5 block">Location</label>
            <Input
              placeholder="e.g., Bondi Junction NSW 2022"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            />
          </div>

          {/* Professions */}
          <div>
            <label className="text-sm font-medium mb-1.5 block">
              Professions{" "}
              <span className="text-muted-foreground font-normal">
                ({selectedProfessions.length} selected)
              </span>
            </label>
            <div className="flex flex-wrap gap-2">
              {PROFESSIONS.map((p) => {
                const selected = selectedProfessions.includes(p.value);
                return (
                  <button
                    key={p.value}
                    type="button"
                    onClick={() => toggleProfession(p.value)}
                    className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium transition-colors border ${
                      selected
                        ? "bg-amber-500/10 text-amber-700 border-amber-500/30 dark:text-amber-400"
                        : "bg-muted/50 text-muted-foreground border-transparent hover:bg-muted"
                    }`}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Limit + Search button */}
          <div className="flex items-end gap-3">
            <div>
              <label className="text-sm font-medium mb-1.5 block">
                Max Results
              </label>
              <Select
                value={limit.toString()}
                onValueChange={(v) => setLimit(parseInt(v))}
              >
                <SelectTrigger className="w-24">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RESULT_LIMITS.map((l) => (
                    <SelectItem key={l} value={l.toString()}>
                      {l}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              onClick={handleSearch}
              disabled={searching || !location.trim() || selectedProfessions.length === 0}
            >
              {searching ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Search className="mr-2 h-4 w-4" />
              )}
              {searching ? "Searching..." : "Search"}
            </Button>
          </div>

          {error && (
            <div className="flex items-center gap-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4" />
              {error}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Results ─────────────────────────────────────────────── */}
      {businesses.length > 0 && (
        <>
          {/* Stats row */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <StatCard label="Total Found" value={stats.total} icon={Building2} />
            <StatCard label="Scanned" value={stats.scanned} icon={ScanSearch} />
            <StatCard label="Has CRM" value={stats.hasCrm} color="green" icon={Globe} />
            <StatCard label="No CRM" value={stats.noCrm} color="amber" icon={Globe} />
            <StatCard label="No Website" value={stats.noWebsite} color="red" icon={Globe} />
          </div>

          {/* Actions bar */}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={handleScan}
              disabled={scanning || stats.scanned === stats.total}
            >
              {scanning ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <ScanSearch className="mr-2 h-4 w-4" />
              )}
              {scanning
                ? "Scanning..."
                : stats.scanned === stats.total
                  ? "All Scanned"
                  : `Scan ${stats.total - stats.scanned} Websites`}
            </Button>

            <Button variant="outline" size="sm" onClick={handleExport}>
              <Download className="mr-2 h-4 w-4" />
              Export CSV
            </Button>

            {cached && (
              <Badge variant="secondary" className="text-xs">
                Cached results
              </Badge>
            )}

            {/* CRM filter */}
            <div className="ml-auto">
              <Select value={crmFilter} onValueChange={setCrmFilter}>
                <SelectTrigger className="w-44">
                  <SelectValue placeholder="Filter by CRM" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All ({stats.total})</SelectItem>
                  <SelectItem value="has_crm">Has CRM ({stats.hasCrm})</SelectItem>
                  <SelectItem value="none">No CRM ({stats.noCrm})</SelectItem>
                  <SelectItem value="no_website">No Website ({stats.noWebsite})</SelectItem>
                  {uniqueCrms.map((crm) => (
                    <SelectItem key={crm} value={crm}>
                      {crm} ({businesses.filter((b) => b.detected_crm === crm).length})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Results table */}
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead
                      className="cursor-pointer hover:text-foreground"
                      onClick={() => handleSort("name")}
                    >
                      Business {sortField === "name" && (sortAsc ? "↑" : "↓")}
                    </TableHead>
                    <TableHead>Contact</TableHead>
                    <TableHead
                      className="cursor-pointer hover:text-foreground"
                      onClick={() => handleSort("google_rating")}
                    >
                      Rating{" "}
                      {sortField === "google_rating" && (sortAsc ? "↑" : "↓")}
                    </TableHead>
                    <TableHead
                      className="cursor-pointer hover:text-foreground"
                      onClick={() => handleSort("detected_crm")}
                    >
                      CRM Status{" "}
                      {sortField === "detected_crm" && (sortAsc ? "↑" : "↓")}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedBusinesses.map((biz) => (
                    <TableRow key={biz.id}>
                      {/* Name + Address */}
                      <TableCell>
                        <div className="font-medium">{biz.name}</div>
                        {biz.address && (
                          <div className="text-xs text-muted-foreground mt-0.5 max-w-xs truncate">
                            {biz.address}
                          </div>
                        )}
                      </TableCell>

                      {/* Phone + Website */}
                      <TableCell>
                        <div className="space-y-1">
                          {biz.phone && (
                            <div className="flex items-center gap-1 text-sm">
                              <Phone className="h-3 w-3 text-muted-foreground" />
                              {biz.phone}
                            </div>
                          )}
                          {biz.website && (
                            <a
                              href={biz.website}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="flex items-center gap-1 text-xs text-blue-600 hover:underline"
                            >
                              <ExternalLink className="h-3 w-3" />
                              {safeHostname(biz.website)}
                            </a>
                          )}
                        </div>
                      </TableCell>

                      {/* Rating */}
                      <TableCell>
                        {biz.google_rating != null ? (
                          <div className="flex items-center gap-1">
                            <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />
                            <span className="text-sm font-medium">
                              {biz.google_rating}
                            </span>
                            {biz.google_review_count != null && (
                              <span className="text-xs text-muted-foreground">
                                ({biz.google_review_count})
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">-</span>
                        )}
                      </TableCell>

                      {/* CRM Status */}
                      <TableCell>
                        <CrmBadge business={biz} />
                      </TableCell>
                    </TableRow>
                  ))}
                  {sortedBusinesses.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={4} className="text-center py-8 text-muted-foreground">
                        No businesses match the current filter.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────────────

function StatCard({
  label,
  value,
  color,
  icon: Icon,
}: {
  label: string;
  value: number;
  color?: "green" | "amber" | "red";
  icon: React.ComponentType<{ className?: string }>;
}) {
  const colorClass =
    color === "green"
      ? "text-green-600"
      : color === "amber"
        ? "text-amber-600"
        : color === "red"
          ? "text-red-500"
          : "text-muted-foreground";

  return (
    <Card className="p-3">
      <div className="flex items-center gap-2">
        <Icon className={`h-4 w-4 ${colorClass}`} />
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
      <div className={`text-2xl font-bold mt-1 ${colorClass}`}>{value}</div>
    </Card>
  );
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function CrmBadge({ business }: { business: Business }) {
  const crm = business.detected_crm;
  const error = business.website_scan_error;

  if (crm === null) {
    return (
      <Badge variant="secondary" className="gap-1 text-xs">
        <Loader2 className="h-3 w-3 animate-spin" />
        Not scanned
      </Badge>
    );
  }

  if (crm === "no_website") {
    return (
      <Badge variant="outline" className="text-xs text-red-500 border-red-200">
        No website
      </Badge>
    );
  }

  if (crm === "none") {
    return (
      <div>
        <Badge variant="outline" className="text-xs text-amber-600 border-amber-200">
          No CRM detected
        </Badge>
        {error && (
          <div className="text-[10px] text-muted-foreground mt-0.5">{error}</div>
        )}
      </div>
    );
  }

  const confidence = business.detected_crm_details?.confidence;
  const variant =
    confidence === "high" ? "default" : confidence === "medium" ? "secondary" : "outline";

  return (
    <Badge variant={variant} className="text-xs bg-green-500/10 text-green-700 border-green-300">
      {crm}
    </Badge>
  );
}
