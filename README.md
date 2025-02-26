# hs.utils

Tools shared across node.js development projects for Hikari Systems

* Authentication middleware
* X-Forwarded-For / LB tools for reverse-proxying cases
* Config management
* Logging management
* Redis client functions
* Langgraph checkpointing and conversational streaming

  NOTE: for langgraph checkpointer, when setting up postgres DB always do `grant create on database "checkpointer-db" to "checkpointer-user;` or equivalent: the setup function needs create schema rights for some crazy reason
