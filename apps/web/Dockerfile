FROM nginx:alpine

# Copy nginx configuration
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy static files
COPY index.html /usr/share/nginx/html/
COPY app.js /usr/share/nginx/html/
COPY api.js /usr/share/nginx/html/
COPY viewer.js /usr/share/nginx/html/

# Copy vendored libraries (Three.js r159 + gcode-preview v2.18.0)
COPY lib/ /usr/share/nginx/html/lib/

# Expose port 80
EXPOSE 80

# Start nginx
CMD ["nginx", "-g", "daemon off;"]
