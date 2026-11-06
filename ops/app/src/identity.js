import { ManagedIdentityCredential } from '@azure/identity';
import { config } from './config.js';

/**
 * The app's user-assigned managed identity (id-iotmq-app). One credential, three audiences:
 *   https://eventgrid.azure.net/.default            MQTT (Entra ID JWT, RBAC on topic spaces)
 *   https://<ns>.servicebus.windows.net/.default    Kafka endpoint of Event Hubs (OAUTHBEARER)
 *   Cosmos DB data plane (keyless)
 */
export const credential = new ManagedIdentityCredential({ clientId: config.clientId });
