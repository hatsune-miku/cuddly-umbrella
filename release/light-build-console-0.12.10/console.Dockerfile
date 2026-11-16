FROM cuddly-console:before-light-console-0.12.10
COPY console/ /usr/share/nginx/html/
RUN chmod -R a+rX /usr/share/nginx/html
