import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ApiError,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  QuotaExceededError,
  InternalServerError,
  ServiceUnavailableError,
} from "../src/utils/errors.ts";

vi.mock("../src/lib/logger.ts", () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe("Error Classes", () => {
  describe("ApiError", () => {
    it("should create error with all properties", () => {
      const error = new ApiError(400, "TEST_ERROR", "Test message", {
        field: "value",
      });

      expect(error.statusCode).toBe(400);
      expect(error.code).toBe("TEST_ERROR");
      expect(error.message).toBe("Test message");
      expect(error.details).toEqual({ field: "value" });
      expect(error.name).toBe("ApiError");
    });

    it("should extend Error class", () => {
      const error = new ApiError(500, "TEST", "message");

      expect(error instanceof Error).toBe(true);
      expect(error instanceof ApiError).toBe(true);
    });

    it("should have stack trace", () => {
      const error = new ApiError(400, "TEST", "message");

      expect(error.stack).toBeDefined();
      expect(error.stack).toContain("ApiError");
    });

    describe("toJSON", () => {
      it("should serialize to JSON format", () => {
        const error = new ApiError(400, "TEST_ERROR", "Test message", {
          field: "value",
        });

        const json = error.toJSON();

        expect(json).toEqual({
          success: false,
          error: {
            code: "TEST_ERROR",
            message: "Test message",
            details: { field: "value" },
          },
        });
      });

      it("should include undefined details if not provided", () => {
        const error = new ApiError(400, "TEST", "message");

        const json = error.toJSON();

        expect(json.error.details).toBeUndefined();
      });
    });
  });

  describe("ValidationError", () => {
    it("should create with status 400", () => {
      const error = new ValidationError("Invalid input");

      expect(error.statusCode).toBe(400);
      expect(error.code).toBe("VALIDATION_ERROR");
      expect(error.message).toBe("Invalid input");
      expect(error.name).toBe("ValidationError");
    });

    it("should accept details", () => {
      const error = new ValidationError("Invalid input", { field: "email" });

      expect(error.details).toEqual({ field: "email" });
    });

    it("should extend ApiError", () => {
      const error = new ValidationError("test");

      expect(error instanceof ApiError).toBe(true);
      expect(error instanceof ValidationError).toBe(true);
    });

    it("should serialize correctly", () => {
      const error = new ValidationError("Bad field", { field: "name" });

      expect(error.toJSON()).toEqual({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Bad field",
          details: { field: "name" },
        },
      });
    });
  });

  describe("AuthenticationError", () => {
    it("should create with status 401 and default message", () => {
      const error = new AuthenticationError();

      expect(error.statusCode).toBe(401);
      expect(error.code).toBe("AUTHENTICATION_ERROR");
      expect(error.message).toBe("Authentication required");
      expect(error.name).toBe("AuthenticationError");
    });

    it("should accept custom message", () => {
      const error = new AuthenticationError("Invalid token");

      expect(error.message).toBe("Invalid token");
    });
  });

  describe("AuthorizationError", () => {
    it("should create with status 403 and default message", () => {
      const error = new AuthorizationError();

      expect(error.statusCode).toBe(403);
      expect(error.code).toBe("AUTHORIZATION_ERROR");
      expect(error.message).toBe("Insufficient permissions");
      expect(error.name).toBe("AuthorizationError");
    });

    it("should accept custom message", () => {
      const error = new AuthorizationError("Admin access required");

      expect(error.message).toBe("Admin access required");
    });
  });

  describe("NotFoundError", () => {
    it("should create with status 404 and default resource", () => {
      const error = new NotFoundError();

      expect(error.statusCode).toBe(404);
      expect(error.code).toBe("NOT_FOUND");
      expect(error.message).toBe("Resource not found");
      expect(error.name).toBe("NotFoundError");
    });

    it("should accept custom resource name", () => {
      const error = new NotFoundError("User");

      expect(error.message).toBe("User not found");
    });

    it("should format message with resource", () => {
      expect(new NotFoundError("Message").message).toBe("Message not found");
      expect(new NotFoundError("Schedule").message).toBe("Schedule not found");
      expect(new NotFoundError("API key").message).toBe("API key not found");
    });
  });

  describe("ConflictError", () => {
    it("should create with status 409", () => {
      const error = new ConflictError("Resource already exists");

      expect(error.statusCode).toBe(409);
      expect(error.code).toBe("CONFLICT");
      expect(error.message).toBe("Resource already exists");
      expect(error.name).toBe("ConflictError");
    });
  });

  describe("RateLimitError", () => {
    it("should create with status 429 and default message", () => {
      const error = new RateLimitError();

      expect(error.statusCode).toBe(429);
      expect(error.code).toBe("RATE_LIMIT_EXCEEDED");
      expect(error.message).toBe("Rate limit exceeded");
      expect(error.name).toBe("RateLimitError");
    });

    it("should accept custom message", () => {
      const error = new RateLimitError("Too many requests, please try again later");

      expect(error.message).toBe("Too many requests, please try again later");
    });
  });

  describe("QuotaExceededError", () => {
    it("should create with status 402 and default message", () => {
      const error = new QuotaExceededError();

      expect(error.statusCode).toBe(402);
      expect(error.code).toBe("QUOTA_EXCEEDED");
      expect(error.message).toBe("Quota exceeded");
      expect(error.name).toBe("QuotaExceededError");
    });

    it("should accept custom message", () => {
      const error = new QuotaExceededError("Daily limit reached");

      expect(error.message).toBe("Daily limit reached");
    });
  });

  describe("InternalServerError", () => {
    it("should create with status 500 and default message", () => {
      const error = new InternalServerError();

      expect(error.statusCode).toBe(500);
      expect(error.code).toBe("INTERNAL_SERVER_ERROR");
      expect(error.message).toBe("Internal server error");
      expect(error.name).toBe("InternalServerError");
    });

    it("should accept custom message", () => {
      const error = new InternalServerError("Database connection failed");

      expect(error.message).toBe("Database connection failed");
    });
  });

  describe("ServiceUnavailableError", () => {
    it("should create with status 503 and default message", () => {
      const error = new ServiceUnavailableError();

      expect(error.statusCode).toBe(503);
      expect(error.code).toBe("SERVICE_UNAVAILABLE");
      expect(error.message).toBe("Service temporarily unavailable");
      expect(error.name).toBe("ServiceUnavailableError");
    });

    it("should accept custom message", () => {
      const error = new ServiceUnavailableError("Maintenance in progress");

      expect(error.message).toBe("Maintenance in progress");
    });
  });

  describe("Error Hierarchy", () => {
    it("all errors should be instances of Error", () => {
      const errors = [
        new ValidationError("test"),
        new AuthenticationError(),
        new AuthorizationError(),
        new NotFoundError(),
        new ConflictError("test"),
        new RateLimitError(),
        new QuotaExceededError(),
        new InternalServerError(),
        new ServiceUnavailableError(),
      ];

      for (const error of errors) {
        expect(error instanceof Error).toBe(true);
        expect(error instanceof ApiError).toBe(true);
      }
    });

    it("all errors should be catchable as Error", () => {
      const throwError = () => {
        throw new ValidationError("test");
      };

      expect(throwError).toThrow(Error);
      expect(throwError).toThrow(ApiError);
      expect(throwError).toThrow(ValidationError);
    });
  });

  describe("Error Status Codes", () => {
    it("should have correct HTTP status codes for each error type", () => {
      const statusCodes = {
        ValidationError: 400,
        AuthenticationError: 401,
        AuthorizationError: 403,
        NotFoundError: 404,
        ConflictError: 409,
        RateLimitError: 429,
        QuotaExceededError: 402,
        InternalServerError: 500,
        ServiceUnavailableError: 503,
      };

      expect(new ValidationError("test").statusCode).toBe(statusCodes.ValidationError);
      expect(new AuthenticationError().statusCode).toBe(statusCodes.AuthenticationError);
      expect(new AuthorizationError().statusCode).toBe(statusCodes.AuthorizationError);
      expect(new NotFoundError().statusCode).toBe(statusCodes.NotFoundError);
      expect(new ConflictError("test").statusCode).toBe(statusCodes.ConflictError);
      expect(new RateLimitError().statusCode).toBe(statusCodes.RateLimitError);
      expect(new QuotaExceededError().statusCode).toBe(statusCodes.QuotaExceededError);
      expect(new InternalServerError().statusCode).toBe(statusCodes.InternalServerError);
      expect(new ServiceUnavailableError().statusCode).toBe(statusCodes.ServiceUnavailableError);
    });
  });

  describe("Error Codes", () => {
    it("should have distinct error codes", () => {
      const errors = [
        new ValidationError("test"),
        new AuthenticationError(),
        new AuthorizationError(),
        new NotFoundError(),
        new ConflictError("test"),
        new RateLimitError(),
        new QuotaExceededError(),
        new InternalServerError(),
        new ServiceUnavailableError(),
      ];

      const codes = errors.map((e) => e.code);
      const uniqueCodes = new Set(codes);

      expect(uniqueCodes.size).toBe(errors.length);
    });
  });

  describe("Error Serialization Edge Cases", () => {
    it("should handle null details", () => {
      const error = new ApiError(400, "TEST", "message", null);
      const json = error.toJSON();

      expect(json.error.details).toBeNull();
    });

    it("should handle complex details object", () => {
      const details = {
        fields: [
          { name: "email", errors: ["required", "format"] },
          { name: "password", errors: ["min_length"] },
        ],
        timestamp: new Date().toISOString(),
        nested: { deep: { value: 123 } },
      };

      const error = new ApiError(400, "TEST", "message", details);
      const json = error.toJSON();

      expect(json.error.details).toEqual(details);
    });

    it("should handle array details", () => {
      const error = new ApiError(400, "TEST", "message", ["error1", "error2"]);
      const json = error.toJSON();

      expect(json.error.details).toEqual(["error1", "error2"]);
    });
  });
});
