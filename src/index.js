export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    // 支持的API端点
    const supportedPaths = ["/api/v1/email"];

    // 只处理 POST 请求到支持的端点
    if (request.method !== "POST" || !supportedPaths.includes(pathname)) {
      return new Response(
        JSON.stringify({
          code: 404,
          msg: "Not Found",
        }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    try {
      const body = await request.json();
      const { message } = body;

      // 处理邮件原始内容
      let rawContent = message.raw;
      if (message.isBase64) {
        // 如果标记为base64编码的，尝试解码回原始格式
        try {
          // 清理base64字符串（移除换行符和空格）
          const cleanBase64 = rawContent.replace(/[\r\n\s]/g, "");
          const binaryString = atob(cleanBase64);
          const bytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }
          rawContent = bytes;
        } catch (decodeError) {
          console.warn("⚠️  Base64解码失败，使用原始字符串内容");
          console.warn("解码错误详情:", decodeError.message);
          // 如果解码失败，保持原始字符串（可能是已经正确的文本内容）
          rawContent = message.raw;
        }
      }

      // 构造模拟的 Email Workers message 对象
      const mockMessage = {
        from: message.from,
        to: message.to,
        raw: rawContent,
        // 模拟 forward 方法
        forward: async (email) => {
          // 在 HTTP 测试模式下，我们不实际转发邮件
          return Promise.resolve();
        },
      };

      return this.email(mockMessage, env, ctx);
    } catch (error) {
      console.error("Error:", error);
      return new Response(error.message, { status: 500 });
    }
  },
  async email(message, env, ctx) {
    try {
      // 真正的流式解析：边读取边处理附件，避免内存累积
      const { attachmentUrls, cleanBody } = await this.streamParseEmail(message.raw, env);
      // 转发邮件
      try {
        await message.forward("2832263188@qq.com");
      } catch (error) {
        console.error("转发 邮件 Error:", error);
        // 记录异常 上报企业微信
        await this.forwardErrorReportText(message.from, message.to, cleanBody);
      }

      // cleanBody 已经是从原始邮件中移除附件后的完整邮件内容（包含头部和正文）
      // 直接将其转换为 File 对象传递给后端
      let emlBuffer;

      // 保持原始邮件的编码，避免乱码
      if (typeof cleanBody === "string") {
        // 如果是字符串，使用UTF-8编码
        emlBuffer = new TextEncoder().encode(cleanBody);
      } else if (cleanBody instanceof Uint8Array) {
        // 如果已经是Uint8Array，直接使用
        emlBuffer = cleanBody;
      } else if (cleanBody instanceof ArrayBuffer) {
        // 如果是ArrayBuffer，转换为Uint8Array
        emlBuffer = new Uint8Array(cleanBody);
      } else {
        // 其他情况，尝试转换为字符串然后编码
        const contentStr = String(cleanBody);
        emlBuffer = new TextEncoder().encode(contentStr);
      }

      console.log(`📊 处理成功 - 附件数量: ${attachmentUrls.length}`);

      const emlFile = new File([emlBuffer], "email.eml", {
        type: "message/rfc822",
      });

      // 创建 FormData
      const formData = new FormData();
      // 添加基本信息
      formData.append("from", message.from);
      formData.append("to", message.to);
      formData.append("raw", emlFile); // 传递 File 对象，就像 message.raw 一样
      formData.append(
        "urlList",
        attachmentUrls.map((item) => item.url)
      ); // 附件 URL 列表
      // 发送到后端API
      const backendResponse = await fetch("https://aiarticle.erweima.ai/api/v1/cf/email", {
        method: "POST",
        body: formData,
      });

      if (!backendResponse.ok) {
        throw new Error(`后端API请求失败: ${backendResponse.status} ${backendResponse.statusText}`);
      }

      return new Response("OK", { status: 200 });
    } catch (error) {
      console.error("Error:", error);
      return new Response("Error processing email", { status: 500 });
    }
  },

  // 真正的流式邮件解析：边读取边上传大附件，避免内存溢出
  async streamParseEmail(rawContent, env) {
    const attachmentUrls = [];
    let headerContent = ""; // 只保留邮件头部
    let boundary = "";
    let isMultipart = false;
    let bodyParts = [];

    try {
      // 流式处理邮件内容
      let contentStream;

      if (rawContent instanceof ReadableStream) {
        contentStream = rawContent;
      } else if (rawContent instanceof ArrayBuffer || rawContent instanceof Uint8Array) {
        // 已经是二进制数据，直接使用字符串解析（因为数据量不大）
        const contentString =
          rawContent instanceof ArrayBuffer
            ? new TextDecoder().decode(rawContent)
            : new TextDecoder().decode(rawContent);

        return this.parseEmailFromString(contentString, env, rawContent);
      } else if (typeof rawContent === "string") {
        // 如果是字符串，说明是小邮件，直接使用字符串解析
        return this.parseEmailFromString(rawContent, env);
      } else {
        // 其他类型转换为Response
        const response = new Response(rawContent);
        contentStream = response.body;
      }

      // 流式读取邮件头部和边界信息
      const reader = contentStream.getReader();
      let buffer = "";
      let headerComplete = false;
      let totalBytesRead = 0;
      const maxHeaderSize = 64 * 1024; // 64KB头部限制

      while (!headerComplete && totalBytesRead < maxHeaderSize) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += new TextDecoder().decode(value);
        totalBytesRead += value.length;

        // 检查是否找到邮件头部结束标记
        const headerEndIndex = buffer.indexOf("\n\n");
        if (headerEndIndex !== -1) {
          headerContent = buffer.substring(0, headerEndIndex);
          headerComplete = true;

          // 检查是否是multipart邮件
          const boundaryMatch =
            headerContent.match(/boundary="([^"]+)"/) || headerContent.match(/boundary=([^;\s]+)/);
          if (boundaryMatch) {
            boundary = boundaryMatch[1];
            isMultipart = true;
          }
        }
      }

      // 如果不是multipart邮件或读取失败，返回简单结果
      if (!isMultipart || !headerComplete) {
        reader.cancel();
        const fallbackContent = typeof rawContent === "string" ? rawContent : headerContent;
        return { attachmentUrls: [], cleanBody: fallbackContent };
      }

      // 继续流式处理邮件体
      await this.processEmailBodyStream(reader, buffer, boundary, attachmentUrls, bodyParts, env);

      // 构建清理后的邮件内容（只包含头部和正文）
      let cleanBody = headerContent + "\n\n";

      if (bodyParts.length > 0) {
        // 只保留正文部分，附件已被移除并上传
        const textParts = bodyParts.filter((part) => part.type === "body");
        if (textParts.length > 0) {
          cleanBody += `--${boundary}\n`;
          cleanBody += textParts.map((part) => part.content).join(`\n--${boundary}\n`);
          cleanBody += `\n--${boundary}--`;
        }
      }

      console.log(`📎 邮件解析完成，附件数量: ${attachmentUrls.length}`);

      return { attachmentUrls, cleanBody };
    } catch (error) {
      console.error("流式邮件解析错误:", error);
    }
  },

  // 从字符串解析邮件（用于小邮件或降级处理）
  async parseEmailFromString(contentString, env, fullContent = null) {
    const attachmentUrls = [];
    let boundary = "";
    let isMultipart = false;
    let bodyParts = [];

    try {
      // 检查是否是 multipart 邮件
      const boundaryMatch =
        contentString.match(/boundary="([^"]+)"/) || contentString.match(/boundary=([^;\s]+)/);
      if (boundaryMatch) {
        boundary = boundaryMatch[1];
        isMultipart = true;
      }

      if (!isMultipart) {
        return { attachmentUrls: [], cleanBody: contentString };
      }

      // 分割邮件部分（限制处理）
      const parts = contentString.split(`--${boundary}`);
      const contentParts = parts.slice(1, -1).slice(0, 10); // 限制最多处理10个部分

      for (const part of contentParts) {
        if (
          part.includes("Content-Disposition: attachment") ||
          part.includes("Content-Disposition:attachment")
        ) {
          // 发现附件
          const filenameMatch =
            part.match(/filename="([^"]+)"/) || part.match(/filename=([^;\s]+)/);
          if (filenameMatch) {
            const filename = filenameMatch[1].replace(/"/g, "");

            // 提取附件内容
            const contentStart =
              part.indexOf("\n\n") !== -1 ? part.indexOf("\n\n") : part.indexOf("\r\n\r\n");
            if (contentStart !== -1) {
              const content = part
                .substring(contentStart + (part.indexOf("\n\n") !== -1 ? 2 : 4))
                .trim();

              // 移除大小限制，全部处理
              try {
                const contentBuffer = this.base64ToUint8Array(content);

                // 移除大小限制，全部上传
                const uploadResult = await this.uploadAttachmentToR2(contentBuffer, filename, env);
                attachmentUrls.push({
                  filename: filename,
                  url: uploadResult.downloadUrl,
                  size: contentBuffer.byteLength,
                  mimeType: uploadResult.mimeType,
                });

                // 立即清理内存
                contentBuffer.fill(0);
              } catch (uploadError) {
                console.error(`❌ 附件上传失败 ${filename}:`, uploadError);
                bodyParts.push({ type: "attachment", content: part, filename });
              }
            }
          }
        } else if (!part.includes("Content-Disposition: attachment")) {
          // 正文部分
          bodyParts.push({ type: "body", content: part });
        }
      }

      // 重建邮件内容
      let cleanBody = contentString.split(`--${boundary}`)[0] + "\n\n";

      for (const part of bodyParts) {
        if (part.type === "body") {
          cleanBody += `--${boundary}${part.content}`;
        } else if (part.type === "attachment") {
          cleanBody += `--${boundary}${part.content}`;
        }
      }

      if (bodyParts.length > 0) {
        cleanBody += `--${boundary}--`;
      }

      return { attachmentUrls, cleanBody };
    } catch (error) {
      console.error("字符串邮件解析错误:", error);
      return { attachmentUrls: [], cleanBody: contentString };
    }
  },

  // 流式处理邮件体（真正的流式处理）
  async processEmailBodyStream(reader, initialBuffer, boundary, attachmentUrls, bodyParts, env) {
    let buffer = initialBuffer;
    const boundaryMarker = `--${boundary}`;
    let partsProcessed = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // 实时解码新读取的数据
        const chunk = new TextDecoder().decode(value);
        buffer += chunk;

        // 处理buffer中的完整部分
        let boundaryIndex;
        while ((boundaryIndex = buffer.indexOf(boundaryMarker)) !== -1) {
          const partEnd = boundaryIndex;
          const part = buffer.substring(0, partEnd);

          if (part.trim()) {
            partsProcessed++;
            await this.processEmailPart(part, boundary, attachmentUrls, bodyParts, env);
          }

          // 移除已处理的部分
          buffer = buffer.substring(partEnd + boundaryMarker.length);

          // 检查是否是结束标记
          if (buffer.startsWith("--")) {
            break;
          }
        }

        // // 防止buffer过大
        // if (buffer.length > 1024 * 1024) {
        //   console.warn("⚠️ 邮件缓冲区过大，可能存在问题");
        //   break;
        // }
      }

      // 处理最后剩余的部分
      if (buffer.trim() && !buffer.startsWith("--")) {
        partsProcessed++;
        await this.processEmailPart(buffer, boundary, attachmentUrls, bodyParts, env);
      }
    } finally {
      reader.cancel();
    }
  },

  // 处理单个邮件部分
  async processEmailPart(part, boundary, attachmentUrls, bodyParts, env) {
    if (
      part.includes("Content-Disposition: attachment") ||
      part.includes("Content-Disposition:attachment")
    ) {
      // 这是附件部分
      const filenameMatch = part.match(/filename="([^"]+)"/) || part.match(/filename=([^;\s]+)/);
      if (filenameMatch) {
        const filename = filenameMatch[1].replace(/"/g, "");

        // 统一流式处理所有附件
        await this.processAttachment(part, filename, attachmentUrls, bodyParts, env);
      }
    } else {
      // 正文部分
      bodyParts.push({ type: "body", content: part });
    }
  },

  // 判断是否为视频文件
  isVideoFile(filename) {
    const videoExtensions = [".mp4", ".avi", ".mkv", ".mov", ".wmv", ".flv", ".webm", ".m4v"];
    const ext = filename.toLowerCase().substring(filename.lastIndexOf("."));
    return videoExtensions.includes(ext);
  },

  // 统一处理所有附件（视频和其他文件）
  async processAttachment(part, filename, attachmentUrls, bodyParts, env) {
    // 根据文件扩展名判断类型
    const isVideo = this.isVideoFile(filename);
    const attachmentType = isVideo ? "video" : "regular";
    const icon = isVideo ? "🎬" : "📎";
    const typeText = isVideo ? "视频" : "普通";

    try {
      // 提取附件内容
      const contentStart =
        part.indexOf("\n\n") !== -1 ? part.indexOf("\n\n") : part.indexOf("\r\n\r\n");
      if (contentStart === -1) {
        console.warn(`⚠️  无法解析附件内容: ${filename}`);
        bodyParts.push({ type: "attachment", content: part, filename });
        return;
      }

      const content = part.substring(contentStart + (part.indexOf("\n\n") !== -1 ? 2 : 4)).trim();

      const contentBuffer = this.base64ToUint8Array(content);

      if (contentBuffer.byteLength === 0) {
        console.error(`❌ 文件解码失败: ${filename}`);
        bodyParts.push({ type: "attachment", content: part, filename });
        return;
      }

      // 统一流式上传到R2（无大小限制）
      const uploadResult = await this.uploadAttachmentToR2(contentBuffer, filename, env);

      attachmentUrls.push({
        filename: filename,
        url: uploadResult.downloadUrl,
        size: contentBuffer.byteLength,
        mimeType: uploadResult.mimeType,
        type: attachmentType, // 标记文件类型
      });

      // 立即清理内存
      contentBuffer.fill(0);
    } catch (uploadError) {
      console.error(`❌ ${typeText}上传失败 ${filename}:`, uploadError);
      bodyParts.push({ type: "attachment", content: part, filename });
    }
  },

  // 判断是否是大附件文件
  isLargeAttachment(filename) {
    const largeFileExtensions = [
      ".mp4",
      ".avi",
      ".mkv",
      ".mov",
      ".wmv",
      ".flv",
      ".webm", // 视频
      ".mp3",
      ".wav",
      ".flac",
      ".aac",
      ".ogg",
      ".m4a", // 音频
      ".zip",
      ".rar",
      ".7z",
      ".tar",
      ".gz", // 压缩包
      ".exe",
      ".dmg",
      ".iso",
      ".bin", // 可执行文件
      ".pdf",
      ".docx",
      ".pptx",
      ".xlsx", // 大文档
    ];

    const ext = filename.toLowerCase().substring(filename.lastIndexOf("."));
    return largeFileExtensions.includes(ext);
  },

  // 流式转换为字符串
  async streamToString(stream) {
    const reader = stream.getReader();
    const chunks = [];
    let done = false;

    while (!done) {
      const { value, done: streamDone } = await reader.read();
      done = streamDone;
      if (value) {
        chunks.push(value);
      }
    }

    const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;

    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }

    return new TextDecoder().decode(result);
  },

  // 高效地将base64字符串转换为Uint8Array，避免内存溢出
  base64ToUint8Array(base64String) {
    try {
      // 检查输入是否有效
      if (!base64String || typeof base64String !== "string") {
        return new Uint8Array(0);
      }

      // 移除可能存在的换行符和空格
      const cleanBase64 = base64String.replace(/[\r\n\s]/g, "");

      // 检查是否是有效的base64格式
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleanBase64)) {
        return new Uint8Array(0);
      }

      // 检查长度是否符合base64要求
      if (cleanBase64.length % 4 !== 0) {
        return new Uint8Array(0);
      }

      // 使用标准的base64解码方法
      const binaryString = atob(cleanBase64);
      const bytes = new Uint8Array(binaryString.length);

      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      return bytes;
    } catch (error) {
      console.error("❌ Base64解码失败:", error.message);
      // 如果标准方法失败，返回空的Uint8Array
      return new Uint8Array(0);
    }
  },

  // 上传附件到 R2 存储（通过文件流上传API）
  async uploadAttachmentToR2(fileBuffer, filename, env) {
    try {
      // 创建 FormData 用于上传
      const formData = new FormData();

      // 创建文件对象
      const file = new File([fileBuffer], filename, {
        type: this.getMimeType(filename),
      });

      // 添加必需参数
      formData.append("file", file);
      formData.append("uploadPath", "email-attachments");
      // formData.append("fileName", filename);
      formData.append("bucketType", "tempfile"); // 使用临时存储

      // 调用文件流上传API
      const uploadResponse = await fetch(
        "https://server-upload.aiquickdraw.com/api/file-stream-upload",
        {
          method: "POST",
          body: formData,
        }
      );

      if (!uploadResponse.ok) {
        throw new Error(
          `文件流上传API请求失败: ${uploadResponse.status} ${uploadResponse.statusText}`
        );
      }

      const uploadResult = await uploadResponse.json();

      if (!uploadResult.success) {
        throw new Error(`文件流上传失败: ${uploadResult.msg || "未知错误"}`);
      }

      // 返回标准化的结果格式
      return {
        success: true,
        fileName: uploadResult.data.fileName,
        filePath: uploadResult.data.filePath,
        downloadUrl: uploadResult.data.downloadUrl,
        fileSize: uploadResult.data.fileSize,
        mimeType: uploadResult.data.mimeType,
        uploadedAt: uploadResult.data.uploadedAt,
        bucketType: uploadResult.data.bucketType,
      };
    } catch (error) {
      throw new Error(`文件上传失败: ${error.message}`);
    }
  },

  // 获取文件MIME类型
  getMimeType(filename) {
    const extension = filename.includes(".")
      ? filename.substring(filename.lastIndexOf(".")).toLowerCase()
      : "";

    const mimeTypes = {
      ".pdf": "application/pdf",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".svg": "image/svg+xml",
      ".txt": "text/plain",
      ".json": "application/json",
      ".zip": "application/zip",
      ".mp4": "video/mp4",
      ".wav": "audio/wav",
      ".doc": "application/msword",
      ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ".xls": "application/vnd.ms-excel",
      ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ".avi": "video/x-msvideo",
      ".mkv": "video/x-matroska",
      ".mov": "video/quicktime",
      ".wmv": "video/x-ms-wmv",
      ".flv": "video/x-flv",
      ".webm": "video/webm",
      ".m4v": "video/mp4",
      ".mp3": "audio/mpeg",
      ".flac": "audio/flac",
      ".aac": "audio/aac",
      ".ogg": "audio/ogg",
      ".m4a": "audio/mp4",
    };

    return mimeTypes[extension] || "application/octet-stream";
  },

  // 上报转发错误到企业微信
  async forwardErrorReportText(from, to, content) {
    try {
      let contentList = await this.splitByLength(content, 1000);

      for (let i = 0; i < contentList.length; i++) {
        let con = contentList[i];
        const dataText = {
          msgtype: "markdown",
          markdown: {
            content:
              '转发邮件异常，请相关同事注意。\n> from: <font color=\"comment\">' +
              from +
              '</font>\n> to:     <font color=\"comment\">' +
              to +
              '</font>\n> time: <font color=\"comment\">' +
              new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) +
              "</font>\n> 邮件内容如下: \n\n" +
              con,
          },
        };
        const responseText = await fetch(
          "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=31b96fa8-dcc9-4a82-b034-af745d57ddcb",
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify(dataText),
          }
        );
      }
    } catch (error) {
      console.error("转发邮件异常上报请求失败:", error);
    }
  },

  // 分割字符
  async splitByLength(str, maxLength) {
    const chunks = [];
    for (let i = 0; i < str.length; i += maxLength) {
      chunks.push(str.slice(i, i + maxLength));
    }
    return chunks;
  },
};
