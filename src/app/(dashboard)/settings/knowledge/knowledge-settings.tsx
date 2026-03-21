"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/use-toast";
import {
  Globe,
  FileText,
  MessageSquare,
  Type,
  Plus,
  Trash2,
  Pencil,
  Loader2,
  ArrowLeft,
  BookOpen,
} from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { KnowledgeScene } from "@/components/ui/empty-state-scenes";
import { trackKnowledgeEntryAdded, trackKnowledgeEntryDeleted } from "@/lib/analytics";

interface KBEntry {
  id: string;
  title: string | null;
  source_type: string;
  source_url: string | null;
  is_active: boolean;
  metadata: Record<string, any> | null;
  created_at: string;
}

interface KnowledgeSettingsProps {
  entries: KBEntry[];
  organizationId: string;
}

const SOURCE_TYPE_ICONS: Record<string, typeof Globe> = {
  website: Globe,
  document: FileText,
  faq: MessageSquare,
  manual: Type,
};

const SOURCE_TYPE_LABELS: Record<string, string> = {
  website: "Website",
  document: "Document",
  faq: "FAQ",
  manual: "Manual Text",
};

export function KnowledgeSettings({
  entries: initialEntries,
  organizationId,
}: KnowledgeSettingsProps) {
  const { toast } = useToast();
  const [entries, setEntries] = useState(initialEntries);
  const [deleteTarget, setDeleteTarget] = useState<KBEntry | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editingEntry, setEditingEntry] = useState<KBEntry | null>(null);
  const [editContent, setEditContent] = useState("");
  const [editTitle, setEditTitle] = useState("");
  const [editFaqPairs, setEditFaqPairs] = useState<
    { question: string; answer: string }[]
  >([]);
  const [isLoadingEdit, setIsLoadingEdit] = useState(false);

  // Add source state
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [websiteTitle, setWebsiteTitle] = useState("");
  const [isScrapingWebsite, setIsScrapingWebsite] = useState(false);

  const [manualTitle, setManualTitle] = useState("");
  const [manualContent, setManualContent] = useState("");
  const [isSavingManual, setIsSavingManual] = useState(false);

  const [faqTitle, setFaqTitle] = useState("");
  const [faqPairs, setFaqPairs] = useState([
    { question: "", answer: "" },
  ]);
  const [isSavingFaq, setIsSavingFaq] = useState(false);

  const [fileTitle, setFileTitle] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  const refreshEntries = useCallback(async () => {
    try {
      const response = await fetch("/api/v1/knowledge-base");
      if (response.ok) {
        const data = await response.json();
        setEntries(data);
      }
    } catch {
      // Silently fail — list will be stale until next page load
    }
  }, []);

  const resetAddForm = () => {
    setWebsiteUrl("");
    setWebsiteTitle("");
    setManualTitle("");
    setManualContent("");
    setFaqTitle("");
    setFaqPairs([{ question: "", answer: "" }]);
    setFileTitle("");
    setSelectedFile(null);
  };

  // ---- Website Import ----
  const handleWebsiteImport = async () => {
    if (!websiteUrl) return;

    let normalizedUrl = websiteUrl;
    if (!websiteUrl.startsWith("http://") && !websiteUrl.startsWith("https://")) {
      normalizedUrl = `https://${websiteUrl}`;
    }

    setIsScrapingWebsite(true);
    try {
      const response = await fetch("/api/v1/knowledge-base/scrape", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: normalizedUrl,
          title: websiteTitle || undefined,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to import website");
      }

      toast({
        title: "Website Imported",
        description: "Knowledge base has been updated.",
      });
      setAddDialogOpen(false);
      resetAddForm();
      await refreshEntries();
    } catch (err: any) {
      toast({
        variant: "destructive",
        title: "Error",
        description: err.message || "Failed to import website.",
      });
    } finally {
      setIsScrapingWebsite(false);
    }
  };

  // ---- Manual Text ----
  const handleSaveManual = async () => {
    if (!manualTitle || !manualContent) {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Title and content are required.",
      });
      return;
    }

    setIsSavingManual(true);
    try {
      const response = await fetch("/api/v1/knowledge-base", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: manualTitle,
          sourceType: "manual",
          content: manualContent,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to save");
      }

      trackKnowledgeEntryAdded("text");
      toast({ title: "Saved", description: "Manual text source added." });
      setAddDialogOpen(false);
      resetAddForm();
      await refreshEntries();
    } catch (err: any) {
      toast({
        variant: "destructive",
        title: "Error",
        description: err.message,
      });
    } finally {
      setIsSavingManual(false);
    }
  };

  // ---- FAQ ----
  const handleSaveFaq = async () => {
    const validPairs = faqPairs.filter(
      (p) => p.question.trim() && p.answer.trim()
    );
    if (!faqTitle || validPairs.length === 0) {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Title and at least one Q&A pair are required.",
      });
      return;
    }

    setIsSavingFaq(true);
    try {
      const response = await fetch("/api/v1/knowledge-base", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: faqTitle,
          sourceType: "faq",
          content: JSON.stringify(validPairs),
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to save");
      }

      trackKnowledgeEntryAdded("faq");
      toast({ title: "Saved", description: "FAQ source added." });
      setAddDialogOpen(false);
      resetAddForm();
      await refreshEntries();
    } catch (err: any) {
      toast({
        variant: "destructive",
        title: "Error",
        description: err.message,
      });
    } finally {
      setIsSavingFaq(false);
    }
  };

  // ---- File Upload ----
  const handleFileUpload = async () => {
    if (!selectedFile) return;

    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", selectedFile);
      if (fileTitle) formData.append("title", fileTitle);

      const response = await fetch("/api/v1/knowledge-base/upload", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to upload");
      }

      toast({ title: "Uploaded", description: "Document source added." });
      setAddDialogOpen(false);
      resetAddForm();
      await refreshEntries();
    } catch (err: any) {
      toast({
        variant: "destructive",
        title: "Error",
        description: err.message,
      });
    } finally {
      setIsUploading(false);
    }
  };

  // ---- Toggle Active ----
  const handleToggle = async (entry: KBEntry) => {
    try {
      const response = await fetch(`/api/v1/knowledge-base/${entry.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !entry.is_active }),
      });

      if (!response.ok) throw new Error("Failed to update");

      setEntries(
        entries.map((e) =>
          e.id === entry.id ? { ...e, is_active: !e.is_active } : e
        )
      );
      toast({
        title: entry.is_active ? "Deactivated" : "Activated",
        description: `Source "${entry.title}" is now ${entry.is_active ? "inactive" : "active"}.`,
      });
    } catch {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to update source.",
      });
    }
  };

  // ---- Delete ----
  const confirmDelete = (entry: KBEntry) => {
    setDeleteTarget(entry);
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);

    try {
      const response = await fetch(`/api/v1/knowledge-base/${deleteTarget.id}`, {
        method: "DELETE",
      });

      if (!response.ok) throw new Error("Failed to delete");

      setEntries(entries.filter((e) => e.id !== deleteTarget.id));
      trackKnowledgeEntryDeleted();
      setDeleteTarget(null);
      toast({ title: "Deleted", description: "Source removed." });
    } catch {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to delete source.",
      });
    } finally {
      setIsDeleting(false);
    }
  };

  // ---- Edit ----
  const openEdit = async (entry: KBEntry) => {
    setEditingEntry(entry);
    setEditTitle(entry.title || "");
    setIsLoadingEdit(true);
    setEditDialogOpen(true);

    try {
      const response = await fetch(`/api/v1/knowledge-base/${entry.id}`);
      if (!response.ok) throw new Error("Failed to fetch");
      const data = await response.json();

      if (entry.source_type === "faq") {
        try {
          setEditFaqPairs(JSON.parse(data.content));
        } catch {
          setEditFaqPairs([{ question: "", answer: "" }]);
        }
        setEditContent("");
      } else {
        setEditContent(data.content || "");
        setEditFaqPairs([]);
      }
    } catch {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to load content.",
      });
      setEditDialogOpen(false);
    } finally {
      setIsLoadingEdit(false);
    }
  };

  const handleSaveEdit = async () => {
    if (!editingEntry) return;

    const content =
      editingEntry.source_type === "faq"
        ? JSON.stringify(editFaqPairs.filter((p) => p.question.trim() && p.answer.trim()))
        : editContent;

    try {
      const response = await fetch(
        `/api/v1/knowledge-base/${editingEntry.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: editTitle, content }),
        }
      );

      if (!response.ok) throw new Error("Failed to save");

      setEntries(
        entries.map((e) =>
          e.id === editingEntry.id ? { ...e, title: editTitle } : e
        )
      );
      setEditDialogOpen(false);
      toast({ title: "Saved", description: "Source updated." });
    } catch {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to save changes.",
      });
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/settings">
            <Button variant="ghost" size="icon" aria-label="Go back">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-bold">Knowledge Base</h1>
            <p className="text-muted-foreground">
              Shared across all your assistants
            </p>
          </div>
        </div>

        <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="h-4 w-4 mr-2" />
              Add Source
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[600px]">
            <DialogHeader>
              <DialogTitle>Add Knowledge Source</DialogTitle>
              <DialogDescription>
                Add information for your AI assistants to reference during calls.
              </DialogDescription>
            </DialogHeader>

            <Tabs defaultValue="website" className="mt-4">
              <TabsList className="grid w-full grid-cols-4">
                <TabsTrigger value="website" className="text-xs">
                  <Globe className="h-3.5 w-3.5 mr-1" />
                  Website
                </TabsTrigger>
                <TabsTrigger value="manual" className="text-xs">
                  <Type className="h-3.5 w-3.5 mr-1" />
                  Text
                </TabsTrigger>
                <TabsTrigger value="faq" className="text-xs">
                  <MessageSquare className="h-3.5 w-3.5 mr-1" />
                  FAQ
                </TabsTrigger>
                <TabsTrigger value="file" className="text-xs">
                  <FileText className="h-3.5 w-3.5 mr-1" />
                  File
                </TabsTrigger>
              </TabsList>

              {/* Website Tab */}
              <TabsContent value="website" className="space-y-4 mt-4">
                <div className="space-y-2">
                  <Label>Title (optional)</Label>
                  <Input
                    placeholder="e.g., Company Website"
                    value={websiteTitle}
                    onChange={(e) => setWebsiteTitle(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Website URL</Label>
                  <div className="flex gap-2">
                    <Input
                      placeholder="www.yourbusiness.com"
                      value={websiteUrl}
                      onChange={(e) => setWebsiteUrl(e.target.value)}
                      className="flex-1"
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    We'll extract services, FAQs, contact info, and business
                    hours
                  </p>
                </div>
                <p className="text-xs text-muted-foreground">
                  By importing, you confirm that you own this website or have
                  permission to use its content.
                </p>
                <Button
                  onClick={handleWebsiteImport}
                  disabled={isScrapingWebsite || !websiteUrl}
                  className="w-full"
                >
                  {isScrapingWebsite ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Importing...
                    </>
                  ) : (
                    "Import Website"
                  )}
                </Button>
              </TabsContent>

              {/* Manual Text Tab */}
              <TabsContent value="manual" className="space-y-4 mt-4">
                <div className="space-y-2">
                  <Label>Title</Label>
                  <Input
                    placeholder="e.g., Business Hours, Pricing Info"
                    value={manualTitle}
                    onChange={(e) => setManualTitle(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Content</Label>
                  <Textarea
                    placeholder="Enter business information, policies, services..."
                    value={manualContent}
                    onChange={(e) => setManualContent(e.target.value)}
                    rows={8}
                  />
                </div>
                <Button
                  onClick={handleSaveManual}
                  disabled={isSavingManual || !manualTitle || !manualContent}
                  className="w-full"
                >
                  {isSavingManual ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Saving...
                    </>
                  ) : (
                    "Save Text"
                  )}
                </Button>
              </TabsContent>

              {/* FAQ Tab */}
              <TabsContent value="faq" className="space-y-4 mt-4">
                <div className="space-y-2">
                  <Label>Title</Label>
                  <Input
                    placeholder="e.g., Common Questions"
                    value={faqTitle}
                    onChange={(e) => setFaqTitle(e.target.value)}
                  />
                </div>
                <div className="space-y-3 max-h-[300px] overflow-y-auto">
                  {faqPairs.map((pair, index) => (
                    <div key={index} className="space-y-2 border rounded-lg p-3">
                      <div className="flex items-center justify-between">
                        <Label className="text-xs text-muted-foreground">
                          Q&A #{index + 1}
                        </Label>
                        {faqPairs.length > 1 && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6"
                            aria-label="Remove question"
                            onClick={() =>
                              setFaqPairs(faqPairs.filter((_, i) => i !== index))
                            }
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        )}
                      </div>
                      <Input
                        placeholder="Question"
                        value={pair.question}
                        onChange={(e) => {
                          const updated = [...faqPairs];
                          updated[index] = {
                            ...updated[index],
                            question: e.target.value,
                          };
                          setFaqPairs(updated);
                        }}
                      />
                      <Textarea
                        placeholder="Answer"
                        value={pair.answer}
                        rows={2}
                        onChange={(e) => {
                          const updated = [...faqPairs];
                          updated[index] = {
                            ...updated[index],
                            answer: e.target.value,
                          };
                          setFaqPairs(updated);
                        }}
                      />
                    </div>
                  ))}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setFaqPairs([...faqPairs, { question: "", answer: "" }])
                  }
                >
                  <Plus className="h-4 w-4 mr-1" />
                  Add Question
                </Button>
                <Button
                  onClick={handleSaveFaq}
                  disabled={isSavingFaq || !faqTitle}
                  className="w-full"
                >
                  {isSavingFaq ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Saving...
                    </>
                  ) : (
                    "Save FAQ"
                  )}
                </Button>
              </TabsContent>

              {/* File Upload Tab */}
              <TabsContent value="file" className="space-y-4 mt-4">
                <div className="space-y-2">
                  <Label>Title (optional)</Label>
                  <Input
                    placeholder="e.g., Employee Handbook"
                    value={fileTitle}
                    onChange={(e) => setFileTitle(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>File (.pdf, .docx)</Label>
                  <Input
                    type="file"
                    accept=".pdf,.docx"
                    onChange={(e) =>
                      setSelectedFile(e.target.files?.[0] || null)
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    Maximum file size: 10MB. Text will be extracted
                    automatically.
                  </p>
                </div>
                <Button
                  onClick={handleFileUpload}
                  disabled={isUploading || !selectedFile}
                  className="w-full"
                >
                  {isUploading ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Uploading...
                    </>
                  ) : (
                    "Upload File"
                  )}
                </Button>
              </TabsContent>
            </Tabs>
          </DialogContent>
        </Dialog>
      </div>

      {/* Entry List */}
      {entries.length === 0 ? (
        <Card>
          <CardContent className="py-4">
            <EmptyState
              icon={BookOpen}
              title="Teach your AI about your business"
              description="Add business information so your AI assistants can answer caller questions accurately."
              illustration={<KnowledgeScene />}
              action={
                <Button onClick={() => setAddDialogOpen(true)}>
                  <Plus className="h-4 w-4 mr-2" />
                  Add Your First Source
                </Button>
              }
            />
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {entries.map((entry) => {
            const Icon = SOURCE_TYPE_ICONS[entry.source_type] || FileText;
            return (
              <Card key={entry.id}>
                <CardContent className="flex items-center justify-between py-4 px-6">
                  <div className="flex items-center gap-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
                      <Icon className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="font-medium">{entry.title || "Untitled"}</p>
                        <Badge variant={entry.is_active ? "default" : "secondary"}>
                          {entry.is_active ? "Active" : "Inactive"}
                        </Badge>
                        <Badge variant="outline">
                          {SOURCE_TYPE_LABELS[entry.source_type] || entry.source_type}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {entry.source_url && <span>{entry.source_url} &middot; </span>}
                        Added{" "}
                        {format(new Date(entry.created_at), "MMM d, yyyy")}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label="Edit source"
                      onClick={() => openEdit(entry)}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleToggle(entry)}
                    >
                      {entry.is_active ? "Deactivate" : "Activate"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label="Delete source"
                      onClick={() => confirmDelete(entry)}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Edit Dialog */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent className="sm:max-w-[600px]">
          <DialogHeader>
            <DialogTitle>Edit Source</DialogTitle>
          </DialogHeader>

          {isLoadingEdit ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
          ) : (
            <div className="space-y-4 mt-2">
              <div className="space-y-2">
                <Label>Title</Label>
                <Input
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                />
              </div>

              {editingEntry?.source_type === "faq" ? (
                <>
                  <div className="space-y-3 max-h-[300px] overflow-y-auto">
                    {editFaqPairs.map((pair, index) => (
                      <div
                        key={index}
                        className="space-y-2 border rounded-lg p-3"
                      >
                        <div className="flex items-center justify-between">
                          <Label className="text-xs text-muted-foreground">
                            Q&A #{index + 1}
                          </Label>
                          {editFaqPairs.length > 1 && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6"
                              aria-label="Remove question"
                              onClick={() =>
                                setEditFaqPairs(
                                  editFaqPairs.filter((_, i) => i !== index)
                                )
                              }
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          )}
                        </div>
                        <Input
                          placeholder="Question"
                          value={pair.question}
                          onChange={(e) => {
                            const updated = [...editFaqPairs];
                            updated[index] = {
                              ...updated[index],
                              question: e.target.value,
                            };
                            setEditFaqPairs(updated);
                          }}
                        />
                        <Textarea
                          placeholder="Answer"
                          value={pair.answer}
                          rows={2}
                          onChange={(e) => {
                            const updated = [...editFaqPairs];
                            updated[index] = {
                              ...updated[index],
                              answer: e.target.value,
                            };
                            setEditFaqPairs(updated);
                          }}
                        />
                      </div>
                    ))}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setEditFaqPairs([
                        ...editFaqPairs,
                        { question: "", answer: "" },
                      ])
                    }
                  >
                    <Plus className="h-4 w-4 mr-1" />
                    Add Question
                  </Button>
                </>
              ) : (
                <div className="space-y-2">
                  <Label>Content</Label>
                  <Textarea
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    rows={12}
                    className="font-mono text-sm"
                  />
                </div>
              )}

              <Button onClick={handleSaveEdit} className="w-full">
                Save Changes
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete confirmation dialog */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Knowledge Source?</DialogTitle>
            <DialogDescription className="space-y-2">
              <span className="block">
                This will permanently delete <span className="font-semibold text-foreground">{deleteTarget?.title || "this source"}</span>.
              </span>
              <span className="block font-semibold text-destructive">This action cannot be undone.</span>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={isDeleting}>Cancel</Button>
            <Button variant="destructive" onClick={handleDelete} disabled={isDeleting}>
              {isDeleting ? "Deleting..." : "Yes, Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
