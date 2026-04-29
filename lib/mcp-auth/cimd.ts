import { RequestHandler } from 'express';
import { ClientStore } from './dcr';

export const createCimdHandler =
  (store: ClientStore): RequestHandler =>
  (req, res) => {
    const clientId = req.params.client_id;
    const registration =
      typeof clientId === 'string' ? store.get(clientId) : undefined;
    res.setHeader('Content-Type', 'application/json');
    if (!registration) {
      res.status(404).json({
        error: 'not_found',
        error_description: 'No client registered with that ID',
      });
      return;
    }
    res.status(200).json(registration);
  };
