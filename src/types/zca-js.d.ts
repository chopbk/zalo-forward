declare module 'zca-js' {
  export enum ThreadType {
    User = 0,
    Group = 1,
  }

  export enum LoginQRCallbackEventType {
    QRCodeGenerated = 0,
    QRCodeExpired = 1,
    QRCodeScanned = 2,
    QRCodeDeclined = 3,
    GotLoginInfo = 4,
  }

  export type Credentials = {
    cookie: unknown;
    imei: string;
    userAgent: string;
    language?: string;
  };

  export type AttachmentSource =
    | string
    | {
        data: Buffer;
        filename: `${string}.${string}`;
        metadata: {
          totalSize: number;
          width?: number;
          height?: number;
        };
      };

  export type MessageContent = {
    msg: string;
    attachments?: AttachmentSource | AttachmentSource[];
    ttl?: number;
  };

  export type ImageMetadataGetterResponse = {
    width: number;
    height: number;
    size: number;
  } | null;

  export type ImageMetadataGetter = (
    filePath: string,
  ) => Promise<ImageMetadataGetterResponse>;

  export type ZaloOptions = {
    selfListen?: boolean;
    checkUpdate?: boolean;
    logging?: boolean;
    imageMetadataGetter?: ImageMetadataGetter;
  };

  export type SendMessageResult = {
    message?: { msgId?: string | number } | null;
    attachment?: Array<{ msgId?: string | number }>;
  };

  export type API = {
    sendMessage: (
      message: string | MessageContent,
      threadId: string,
      type?: ThreadType,
    ) => Promise<SendMessageResult>;
    getAllGroups: () => Promise<{ gridVerMap?: Record<string, string> }>;
    getGroupInfo: (groupId: string | string[]) => Promise<{
      gridInfoMap?: Record<
        string,
        { name?: string; totalMember?: number; createdTime?: number }
      >;
    }>;
    getOwnId: () => string;
    listener: {
      on: (event: 'message', cb: (message: ZaloListenerMessage) => void) => void;
      start: () => void;
      stop: () => void;
    };
  };

  export type ZaloListenerMessage = {
    type: ThreadType;
    threadId: string;
    isSelf: boolean;
    data: {
      content?: unknown;
      msgType?: string;
      msgId?: string | number;
      uidFrom?: string | number;
      dName?: string;
      ts?: string | number;
    };
  };

  export type LoginQRCallbackEvent =
    | {
        type: LoginQRCallbackEventType.QRCodeGenerated;
        data: { code?: string; image?: string };
        actions: {
          saveToFile: (path: string) => Promise<void>;
          retry: () => void;
          abort: () => void;
        };
      }
    | {
        type: LoginQRCallbackEventType.QRCodeExpired;
        data: unknown;
        actions: { retry: () => void; abort: () => void };
      }
    | {
        type: LoginQRCallbackEventType.QRCodeScanned;
        data: { display_name?: string };
        actions: { retry: () => void; abort: () => void };
      }
    | {
        type: LoginQRCallbackEventType.QRCodeDeclined;
        data: unknown;
        actions: { retry: () => void; abort: () => void };
      }
    | {
        type: LoginQRCallbackEventType.GotLoginInfo;
        data: {
          cookie: Credentials['cookie'];
          imei: string;
          userAgent: string;
        };
        actions: { retry: () => void; abort: () => void };
      };

  export class Zalo {
    constructor(options?: ZaloOptions);
    login(credentials: Credentials): Promise<API>;
    loginQR(
      options?: Record<string, unknown>,
      callback?: (event: LoginQRCallbackEvent) => void,
    ): Promise<API>;
  }
}
