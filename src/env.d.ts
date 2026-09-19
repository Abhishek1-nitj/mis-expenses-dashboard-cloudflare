export interface Env {
  DB: any;
  ASSETS: { fetch(req: Request): Promise<Response> };
  SPREADSHEET_ID: string;
  GOOGLE_SERVICE_ACCOUNT_JSON: string;
  VOLOPAY_ACCESS_TOKEN?: string;
  VOLOPAY_CLIENT?: string;
  VOLOPAY_UID?: string;
  VOLOPAY_ACCOUNT?: string;
}

declare module "lucide-react/dist/esm/icons/*.mjs" {
  import React from "react";
  const icon: React.FC<any>;
  export default icon;
}

declare module "lucide-react/dist/esm/icons/chevron-down.mjs" {
  import React from "react";
  const icon: React.FC<any>;
  export default icon;
}

declare module "lucide-react/dist/esm/icons/x.mjs" {
  import React from "react";
  const icon: React.FC<any>;
  export default icon;
}

declare module "lucide-react/dist/esm/icons/check.mjs" {
  import React from "react";
  const icon: React.FC<any>;
  export default icon;
}

