// Package digimart — configuration. The ONLY file that reads the environment.
//
// Two surfaces, two credentials:
//   - the charging SDK (signed URLs on user.digimart.store): API Key + API Secret
//   - the REST APIs (JSON on api.digimart.store): applicationId + App Password
//
// plus one URL per flow or call you actually use. An unset endpoint means the
// service is off, and the client refuses to use it.
//
// Call LoadConfig once at startup so a misconfigured deployment fails at boot.
// SERVER-SIDE ONLY — the API Secret can charge your customers.
package digimart

import (
	"fmt"
	"os"
	"strings"
)

// EndpointVariables maps each service to its environment variable.
var EndpointVariables = map[string]string{
	"subscriptionAuthorize": "DIGIMART_SUBSCRIPTION_AUTHORIZE_URL",
	"caasAuthorize":         "DIGIMART_CAAS_AUTHORIZE_URL",
	"getSubscribers":        "DIGIMART_GET_SUBSCRIBERS_URL",
	"chargingInfo":          "DIGIMART_CHARGING_INFO_URL",
	"unregistration":        "DIGIMART_UNREGISTRATION_URL",
}

// Config holds everything Digimart needs. apiSecret and password are
// unexported so they cannot be marshalled into a response by accident.
type Config struct {
	ApplicationID string
	APIKey        string
	apiSecret     string
	RedirectURL   string
	password      string
	endpoints     map[string]string
}

func optional(name string) string { return strings.TrimSpace(os.Getenv(name)) }

func required(name, why string) (string, error) {
	if v := optional(name); v != "" {
		return v, nil
	}
	return "", fmt.Errorf("[digimart] missing required environment variable %s (%s); copy templates/.env.example to .env or set it in your secret manager", name, why)
}

// LoadConfig reads and validates the environment.
func LoadConfig() (*Config, error) {
	c := &Config{endpoints: map[string]string{}}
	for service, variable := range EndpointVariables {
		if v := optional(variable); v != "" {
			c.endpoints[service] = v
		}
	}
	usesSDK := c.endpoints["subscriptionAuthorize"] != "" || c.endpoints["caasAuthorize"] != ""
	usesREST := c.endpoints["getSubscribers"] != "" || c.endpoints["chargingInfo"] != "" || c.endpoints["unregistration"] != ""

	var err error
	if c.ApplicationID, err = required("DIGIMART_APP_ID", "every notification is verified against it"); err != nil {
		return nil, err
	}
	if usesSDK {
		if c.APIKey, err = required("DIGIMART_API_KEY", "an authorize URL is configured"); err != nil {
			return nil, err
		}
		if c.apiSecret, err = required("DIGIMART_API_SECRET", "an authorize URL is configured"); err != nil {
			return nil, err
		}
		if c.RedirectURL, err = required("DIGIMART_REDIRECT_URL", "an authorize URL is configured"); err != nil {
			return nil, err
		}
		if !strings.HasPrefix(c.RedirectURL, "https://") {
			return nil, fmt.Errorf("[digimart] DIGIMART_REDIRECT_URL must be an absolute https:// URL")
		}
	}
	if usesREST {
		if c.password, err = required("DIGIMART_PASSWORD", "a REST endpoint is configured"); err != nil {
			return nil, err
		}
	}
	return c, nil
}

// RequireEndpoint resolves an endpoint or names the missing variable.
func (c *Config) RequireEndpoint(service string) (string, error) {
	if u := c.endpoints[service]; u != "" {
		return u, nil
	}
	return "", fmt.Errorf("[digimart] %s is not configured; set %s (see .env.example)", service, EndpointVariables[service])
}

// Describe is a redacted view, safe to log at startup.
func (c *Config) Describe() map[string]any {
	enabled := []string{}
	for s := range c.endpoints {
		enabled = append(enabled, s)
	}
	redact := func(s string) string {
		if s == "" {
			return "(unset)"
		}
		return "***redacted***"
	}
	return map[string]any{"applicationId": c.ApplicationID, "apiSecret": redact(c.apiSecret), "password": redact(c.password), "enabled": enabled}
}
