import { expect, test } from "bun:test";
import { encodePath, presign, signHeaders } from "./sigv4.ts";

// The example in AWS's own documentation of a presigned URL ("Authenticating Requests: Using
// Query Parameters"), whose signature it gives: a signer that gets any part of the canonical
// request wrong gets another.
const AWS_EXAMPLE = {
  credentials: {
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
  },
  now: Date.UTC(2013, 4, 24),
};

test("a presigned GET matches AWS's documented example to the signature", async () => {
  const url = await presign(AWS_EXAMPLE.credentials, {
    method: "GET",
    url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
    headers: {},
    now: AWS_EXAMPLE.now,
    expiresIn: 86_400,
  });

  expect(url.searchParams.get("X-Amz-Credential")).toBe(
    "AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request",
  );
  expect(url.searchParams.get("X-Amz-Date")).toBe("20130524T000000Z");
  expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
  expect(url.searchParams.get("X-Amz-Signature")).toBe(
    "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
  );
});

test("every header given is bound into the signature, by its lowercase name", async () => {
  const sign = (headers: Record<string, string>) =>
    presign(AWS_EXAMPLE.credentials, {
      method: "PUT",
      url: new URL("https://examplebucket.s3.amazonaws.com/a.png"),
      headers,
      now: AWS_EXAMPLE.now,
      expiresIn: 600,
    });

  const png = await sign({ "Content-Type": "image/png", "content-length": "10" });
  const svg = await sign({ "content-type": "image/svg+xml", "content-length": "10" });

  expect(png.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host");
  expect(png.searchParams.get("X-Amz-Signature")).not.toBe(svg.searchParams.get("X-Amz-Signature"));
});

test("a signed request carries its date, an unsigned payload and the authorization", async () => {
  const headers = await signHeaders(AWS_EXAMPLE.credentials, {
    method: "HEAD",
    url: new URL("https://examplebucket.s3.amazonaws.com/a.png"),
    headers: { "Accept-Encoding": "identity" },
    now: AWS_EXAMPLE.now,
  });

  expect(headers).toMatchObject({
    "accept-encoding": "identity",
    "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
    "x-amz-date": "20130524T000000Z",
  });
  expect(headers.authorization).toMatch(
    /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20130524\/us-east-1\/s3\/aws4_request, SignedHeaders=accept-encoding;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
  );
});

test("a key is encoded segment by segment, as S3 signs it", () => {
  expect(encodePath("k3y/assets/Team photo (1)!.png")).toBe(
    "k3y/assets/Team%20photo%20%281%29%21.png",
  );
});
