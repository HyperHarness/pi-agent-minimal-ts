export interface PaperWikiSourceInput {
  workspaceDir: string;
  paperKey: string;
  summaryMarkdown: string;
  engine?: "opendataloader-local" | "opendataloader-hybrid" | "plain-text-baseline";
  title?: string;
  tags?: string[];
  keyFindings?: string[];
  limitations?: string[];
  openQuestions?: string[];
  relatedPaperKeys?: string[];
}

export interface PaperWikiSourceResult {
  paperKey: string;
  title: string;
  sourcePath: string;
  indexPath: string;
  logPath: string;
  schemaPath: string;
}

export interface PaperWikiSearchOptions {
  workspaceDir: string;
  query: string;
  maxResults?: number;
}

export interface PaperWikiSearchResult {
  query: string;
  results: Array<{
    paperKey: string;
    title: string;
    path: string;
    snippet: string;
  }>;
}
