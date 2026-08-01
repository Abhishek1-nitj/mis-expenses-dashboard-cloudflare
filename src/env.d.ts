export interface Env {
  DB: any;
  ASSETS: { fetch(req: Request): Promise<Response> };
  SPREADSHEET_ID: string;
  GOOGLE_SERVICE_ACCOUNT_JSON: string;
}
